// Bounded, resumable provider walks. Providers get an optional store from the
// real scanner; probes/imports/dry runs never open or write one themselves.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { withPipelineLock } from './pipeline-lock.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';
import { isRetryableError } from './providers/_http.mjs';

export const CONTINUATION_DIR = 'data/cache/provider-continuations';
export const CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTINUATION_CHUNK_BUDGET_MS = 120_000;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const SUPPORTED = new Set(['eightfold', 'oraclecloud']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function continuationIdentity(providerId, entry) {
  // Budget changes can keep their progress. Endpoint/query changes cannot.
  const source = Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith('_') && key !== 'max_pages'));
  return createHash('sha256').update(JSON.stringify([providerId, stable(source)])).digest('hex');
}

function validState(state, identity, now) {
  return state?.version === 1 && state.identity === identity
    && Number.isFinite(state.startedAt) && now >= state.startedAt && now - state.startedAt < CONTINUATION_TTL_MS
    && Number.isInteger(state.page) && state.page >= 0 && state.page <= 100_000
    && Array.isArray(state.jobs) && state.jobs.length <= 100_000
    && state.jobs.every(job => typeof job?.title === 'string' && typeof job?.url === 'string' && /^https?:\/\//.test(job.url))
    && state.meta && typeof state.meta === 'object' && !Array.isArray(state.meta)
    && (state.retryAt == null || (Number.isFinite(state.retryAt) && state.retryAt >= 0));
}

/** Serialize one board's whole fetch against overlapping scans. No writes on import. */
export async function withProviderContinuation({ root, providerId, entry, enabled = true, now = Date.now }, run) {
  if (!enabled || !SUPPORTED.has(providerId)) return run(undefined);
  const identity = continuationIdentity(providerId, entry);
  const file = path.join(root, CONTINUATION_DIR, `${identity}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  return withPipelineLock(file, async () => {
    const store = {
      now,
      deadlineAt: now() + CONTINUATION_CHUNK_BUDGET_MS,
      read() {
        if (!existsSync(file)) return null;
        try {
          if (statSync(file).size > MAX_STATE_BYTES) throw new Error('checkpoint exceeds size limit');
          const state = JSON.parse(readFileSync(file, 'utf8'));
          if (!validState(state, identity, now())) throw new Error('checkpoint is stale or incompatible');
          return state;
        } catch (error) {
          console.error(`provider continuation: restarting ${providerId}; ${error.message}`);
          return null;
        }
      },
      write(value) {
        const state = { ...value, version: 1, identity };
        const text = JSON.stringify(state);
        if (!validState(state, identity, now()) || Buffer.byteLength(text) > MAX_STATE_BYTES) {
          throw new Error('provider continuation: invalid or oversized checkpoint');
        }
        writeFileAtomic(file, `${text}\n`);
      },
      clear() {
        try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      },
    };
    return run(store);
  }, { timeoutMs: 1_000, maxWaitMs: 1_000 });
}

/** Small page-walk state machine; providers retain their own API/stop rules. */
export function openProviderWalk(ctx, providerId) {
  const store = ctx?.maxPages == null ? ctx?.continuation : undefined;
  const saved = store?.read() ?? null;
  const now = store?.now ?? Date.now;
  const jobs = [...(saved?.jobs ?? [])];
  const seen = new Set(jobs.map(job => job.url));
  let durable = Boolean(saved);
  const walk = {
    jobs,
    page: saved?.page ?? 0,
    meta: saved?.meta ?? {},
    startedAt: saved?.startedAt ?? now(),
    retryAt: saved?.retryAt ?? null,
    resumed: Boolean(saved),
    pagesThisRun: 0,
    budgetExpired: () => store?.deadlineAt != null && now() >= store.deadlineAt,
    save() {
      if (!store) return;
      try {
        store.write({ startedAt: walk.startedAt, page: walk.page, jobs, meta: walk.meta, retryAt: walk.retryAt });
        durable = true;
      } catch (error) {
        durable = false;
        console.error(`provider continuation: could not save ${providerId}: ${error.message}`);
      }
    },
    add(pageJobs, nextPage, meta) {
      let fresh = 0;
      for (const job of pageJobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
        fresh++;
      }
      walk.page = nextPage;
      walk.pagesThisRun++;
      walk.meta = meta;
      walk.retryAt = null;
      walk.save(); // a crash on the next request replays at most that request
      return fresh;
    },
    partial(reason, error, resumable = true) {
      if (!resumable) walk.meta = { ...walk.meta, haltedReason: reason };
      if (error && isRetryableError(error)) {
        walk.retryAt = error.retryAt ?? now() + 30_000;
      }
      walk.save();
      const coverage = {
        complete: false, provider: providerId, reason,
        fetched: jobs.length, total: Number.isFinite(walk.meta.total) ? walk.meta.total : null,
        next_page: walk.page, pages_this_run: walk.pagesThisRun, resumed: walk.resumed,
        resumable: resumable && durable, snapshot_started_at: new Date(walk.startedAt).toISOString(),
        ...(walk.retryAt ? { retry_at: new Date(walk.retryAt).toISOString() } : {}),
        ...(error?.status ? { status: error.status } : {}),
      };
      Object.defineProperty(jobs, 'coverage', { value: coverage, configurable: true });
      if (error && typeof error === 'object') error.coverage = coverage;
      return jobs;
    },
    failure(error) {
      const reason = error.retryBudgetExhausted ? 'time_budget' : error.retryDeferred ? 'retry_after' : error.status === 429 ? 'rate_limit'
        : error.status >= 500 ? 'server_error' : error.timedOut ? 'timeout' : 'fetch_error';
      walk.partial(reason, error, isRetryableError(error));
      if (!jobs.length || !isRetryableError(error)) throw error;
      return jobs;
    },
    deferred() {
      if (walk.meta.haltedReason) {
        walk.partial(walk.meta.haltedReason, undefined, false);
        return true;
      }
      if (!(walk.retryAt > now())) return false;
      walk.partial('retry_after');
      return true;
    },
    complete() {
      store?.clear();
      return jobs;
    },
  };
  return walk;
}

/** Retain older providers' partial flags in scan receipts without guessing completeness. */
export function providerCoverage(jobs, providerId) {
  if (jobs?.coverage) return jobs.coverage;
  const flag = Object.keys(jobs ?? {}).find(key => key.endsWith('Truncated') && jobs[key]);
  if (!flag) return null;
  const value = jobs[flag];
  return {
    complete: false, provider: providerId,
    reason: value === 'transient' ? 'fetch_error' : value === 'cap' ? 'page_cap'
      : value === 'structural' ? 'structural_limit' : 'provider_partial',
    fetched: jobs.length, resumable: false,
  };
}
