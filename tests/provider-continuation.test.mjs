import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import eightfold from '../providers/eightfold.mjs';
import oracle from '../providers/oraclecloud.mjs';
import { fetchJsonWithRetry } from '../providers/_http.mjs';
import { CONTINUATION_DIR, CONTINUATION_TTL_MS, CONTINUATION_CHUNK_BUDGET_MS, continuationIdentity, withProviderContinuation, providerCoverage } from '../provider-continuation.mjs';

const entry = { name: 'Synthetic Board', careers_url: 'https://synthetic.eightfold.ai/careers', max_pages: 1 };
const page = (offset, total = 25) => ({
  positions: Array.from({ length: Math.max(0, Math.min(10, total - offset)) }, (_, i) => ({ id: String(offset + i), name: `Engineer ${offset + i}` })),
  count: total,
});
const scratch = () => mkdtempSync(join(tmpdir(), 'career-ops-continuation-'));
const run = (root, target, fetchJson, now = Date.now) => withProviderContinuation({
  root, providerId: 'eightfold', entry: target, now,
}, continuation => eightfold.fetch(target, { fetchJson, sleep: async () => {}, continuation }));

test('ordinary scans resume capped chunks, retain earlier jobs, and reset after completion', async () => {
  const root = scratch();
  const offsets = [];
  const fetchJson = async url => { const offset = Number(new URL(url).searchParams.get('start')); offsets.push(offset); return page(offset); };
  try {
    const first = await run(root, entry, fetchJson);
    assert.equal(first.length, 10);
    assert.equal(first.coverage.reason, 'page_cap');
    assert.equal(first.coverage.resumable, true);
    const second = await run(root, { ...entry, max_pages: 2 }, fetchJson);
    assert.equal(second.length, 25);
    assert.deepEqual(offsets, [0, 10, 20]);
    assert.equal(second.coverage, undefined);
    assert.equal(new Set(second.map(job => job.url)).size, 25);
    assert.deepEqual(readdirSync(join(root, CONTINUATION_DIR)), []);
    await run(root, entry, fetchJson);
    assert.deepEqual(offsets, [0, 10, 20, 0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('long first-page Retry-After persists cooldown without sleeping or issuing an early retry', async () => {
  const root = scratch();
  let now = Date.now();
  let calls = 0;
  const failure = Object.assign(new Error('HTTP 429'), { status: 429, retryAfter: '120' });
  try {
    await assert.rejects(run(root, entry, async () => { calls++; throw failure; }, () => now), error => error === failure);
    assert.equal(calls, 1);
    assert.equal(failure.coverage.reason, 'retry_after');
    assert.equal(failure.coverage.resumable, true);
    const deferred = await run(root, entry, async () => { calls++; return page(0); }, () => now);
    assert.equal(calls, 1);
    assert.equal(deferred.coverage.reason, 'retry_after');
    now = failure.retryAt + 1;
    const recovered = await run(root, entry, async () => { calls++; return page(0, 1); }, () => now);
    assert.equal(calls, 2);
    assert.equal(recovered.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mid-walk 503 keeps the failed offset and resumes only after cooldown', async () => {
  const root = scratch();
  const offsets = [];
  let now = Date.now();
  const target = { ...entry, max_pages: 3 };
  const failure = Object.assign(new Error('HTTP 503'), { status: 503, retryAfter: '90' });
  try {
    const partial = await run(root, target, async url => {
      const offset = Number(new URL(url).searchParams.get('start')); offsets.push(offset);
      if (offset === 10) throw failure;
      return page(offset);
    }, () => now);
    assert.equal(partial.length, 10);
    assert.equal(partial.coverage.next_page, 1);
    assert.equal(partial.coverage.reason, 'retry_after');
    now = failure.retryAt + 1;
    const complete = await run(root, target, async url => {
      const offset = Number(new URL(url).searchParams.get('start')); offsets.push(offset); return page(offset);
    }, () => now);
    assert.equal(complete.length, 25);
    assert.deepEqual(offsets, [0, 10, 10, 20]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PCSX API selection persists across chunks without repeating the v2 probe', async () => {
  const root = scratch();
  const paths = [];
  const fetchJson = async url => {
    const parsed = new URL(url); paths.push(parsed.pathname);
    if (parsed.pathname.includes('/apply/')) throw Object.assign(new Error('HTTP 403'), { status: 403 });
    return { data: page(Number(parsed.searchParams.get('start')), 11) };
  };
  try {
    await run(root, entry, fetchJson);
    const complete = await run(root, entry, fetchJson);
    assert.equal(complete.length, 11);
    assert.deepEqual(paths, ['/api/apply/v2/jobs', '/api/pcsx/search', '/api/pcsx/search']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('endpoint/domain/query changes isolate checkpoints, page-cap changes preserve them, expiry restarts', async () => {
  const root = scratch();
  let now = Date.now();
  try {
    assert.equal(continuationIdentity('eightfold', entry), continuationIdentity('eightfold', { ...entry, max_pages: 5 }));
    for (const change of [{ domain: 'other.example' }, { api: 'https://another.eightfold.ai/api/apply/v2/jobs' }, { query: 'changed' }]) {
      assert.notEqual(continuationIdentity('eightfold', entry), continuationIdentity('eightfold', { ...entry, ...change }));
    }
    await run(root, entry, async () => page(0), () => now);
    now += CONTINUATION_TTL_MS + 1;
    const offsets = [];
    await run(root, entry, async url => { offsets.push(Number(new URL(url).searchParams.get('start'))); return page(0); }, () => now);
    assert.deepEqual(offsets, [0]);
    assert.equal(JSON.parse(readFileSync(join(root, CONTINUATION_DIR, `${continuationIdentity('eightfold', entry)}.json`))).startedAt, now);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a chunk time budget checkpoints before the next request instead of walking indefinitely', async () => {
  const root = scratch();
  let now = Date.now();
  const offsets = [];
  const target = { ...entry, max_pages: 200 };
  try {
    const partial = await run(root, target, async url => {
      const offset = Number(new URL(url).searchParams.get('start')); offsets.push(offset);
      now += CONTINUATION_CHUNK_BUDGET_MS;
      return page(offset, 11);
    }, () => now);
    assert.equal(partial.coverage.reason, 'time_budget');
    assert.equal(partial.coverage.next_page, 1);
    assert.deepEqual(offsets, [0]);
    const completed = await run(root, target, async url => {
      const offset = Number(new URL(url).searchParams.get('start')); offsets.push(offset); return page(offset, 11);
    }, () => now);
    assert.equal(completed.length, 11);
    assert.deepEqual(offsets, [0, 10]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dry-run context neither creates nor advances state; probes ignore supplied continuations', async () => {
  const root = scratch();
  try {
    await withProviderContinuation({ root, providerId: 'eightfold', entry, enabled: false }, continuation => {
      assert.equal(continuation, undefined);
    });
    assert.deepEqual(readdirSync(root), []);
    const jobs = await eightfold.fetch({ ...entry, max_pages: 3 }, {
      maxPages: 1, continuation: { read() { throw new Error('probe read a checkpoint'); } },
      fetchJson: async () => page(0), sleep: async () => {},
    });
    assert.equal(jobs.length, 10);
    assert.equal(jobs.coverage, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Oracle continuation advances exact 200-row offsets without increasing the chunk cap', async () => {
  const root = scratch();
  const target = { name: 'Synthetic Oracle', careers_url: 'https://synthetic.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', max_pages: 1 };
  const offsets = [];
  const invoke = () => withProviderContinuation({ root, providerId: 'oraclecloud', entry: target }, continuation => oracle.fetch(target, {
    continuation, sleep: async () => {}, fetchJson: async url => {
      const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
      return { items: [{ TotalJobsCount: 201, requisitionList: Array.from({ length: offset ? 1 : 200 }, (_, i) => ({ Id: String(offset + i), Title: 'Engineer' })) }] };
    },
  }));
  try {
    assert.equal((await invoke()).coverage.reason, 'page_cap');
    assert.equal((await invoke()).length, 201);
    assert.deepEqual(offsets, [0, 200]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Retry-After is a lower bound; long headers defer rather than clamp; 403 never retries', async () => {
  const waits = [];
  let calls = 0;
  const ctx = {
    sleep: async ms => waits.push(ms),
    fetchJson: async () => { if (calls++ === 0) throw Object.assign(new Error('HTTP 503'), { status: 503, retryAfter: '1' }); return 'ok'; },
  };
  assert.equal(await fetchJsonWithRetry(ctx, 'https://example.invalid', {}, { retries: 1, baseDelayMs: 100, maxDelayMs: 500 }), 'ok');
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 1000 && waits[0] <= 2000);
  calls = 0;
  await assert.rejects(fetchJsonWithRetry({ sleep: async () => assert.fail('must defer, not sleep'), fetchJson: async () => {
    calls++; throw Object.assign(new Error('HTTP 503'), { status: 503, retryAfter: '3600' });
  } }, 'https://example.invalid'), error => error.retryDeferred && error.attempts === 1);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchJsonWithRetry({ fetchJson: async () => { calls++; throw Object.assign(new Error('HTTP 403'), { status: 403 }); } }, 'https://example.invalid'));
  assert.equal(calls, 1);
  const httpDate = new Date(Date.now() + 60_000).toUTCString();
  await assert.rejects(fetchJsonWithRetry({ fetchJson: async () => {
    throw Object.assign(new Error('HTTP 429'), { status: 429, retryAfter: httpDate });
  } }, 'https://example.invalid', {}, { maxDelayMs: 500 }), error => error.retryDeferred && error.retryAt >= Date.now() + 58_000);
});

test('legacy partial flags remain incomplete without claiming unsupported resume capability', () => {
  const jobs = [{ title: 'Engineer', url: 'https://example.invalid/jobs/1' }];
  jobs.workdayTruncated = 'structural';
  assert.deepEqual(providerCoverage(jobs, 'workday'), { complete: false, provider: 'workday', reason: 'structural_limit', fetched: 1, resumable: false });
});
