// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { safeEncodeURIComponent } from './_safe-url.mjs';
import { fetchJsonWithRetry } from './_http.mjs';

// JibeApply provider — hits the /api/jobs endpoint on the same hostname.
// Auto-detects from careers_url pattern `https://<slug>.jibeapply.com`.
// iCIMS acquired Jibe in 2019; some tenants run it on a branded custom
// domain instead. The JSON API at /api/jobs is stable across all tenants.

// Safety cap on pagination — applied regardless of what the upstream reports
// as totalCount, so a misbehaving/compromised API can't drive this into
// fetching thousands of pages. Every known real tenant (10/page) stays well
// under the default of 50 pages (500 jobs); override with `max_pages` on the
// portal entry for a tenant that genuinely exceeds it — each page is a
// sequential round-trip, so raising the default for everyone isn't free.
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 500;

// Fallback page size when a response carries no jobs and no usable `count`
// (e.g. an empty first page). Confirmed live against real tenants — JibeApply
// reports this as `filter.displayLimit` and it has been 10 on every tenant
// observed so far.
const DEFAULT_PAGE_SIZE = 10;

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function toApiUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/^[a-z0-9-]+\.jibeapply\.com$/i.test(u.hostname)) return null;
  if (!u.pathname.startsWith('/api/')) {
    u.pathname = '/api' + (u.pathname.startsWith('/') ? u.pathname : '/' + u.pathname);
  }
  return u.href;
}

// Validate an explicit entry.api URL (any HTTPS hostname — used for iCIMS-hosted,
// branded JibeApply sites that share the same JSON schema).
function validateExplicitApi(apiUrl) {
  let u;
  try { u = new URL(apiUrl); } catch { return null; }
  return u.protocol === 'https:' ? u.href : null;
}

// The API's posted_date is the publication date. Updated/modified timestamps
// must never make an old opening look newly posted. Only explicit ISO dates
// or timestamps with an offset are accepted; missing/invalid stays unknown.
function postedDateMs(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59)) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseJibeapplyResponse(json, entry) {
  let origin = '';
  try { origin = new URL(entry.careers_url || '').origin; } catch { /* ignore */ }
  // careers_url isn't required to be a well-formed absolute URL for fetch()
  // to succeed (an explicit entry.api bypasses it entirely — see toApiUrl
  // callers below) — fall back to api's origin so job URLs stay absolute
  // instead of silently degrading to a relative "/jobs/<slug>" path.
  if (!origin) {
    try { origin = new URL(entry.api || '').origin; } catch { /* ignore */ }
  }
  const items = Array.isArray(json?.jobs) ? json.jobs : [];
  return items
    .map(item => {
      if (item == null) return null;
      const d = item.data ?? item;
      const title = String(d.title || '').trim();
      const slug = d.slug || d.req_id;
      if (!title || !slug) return null;
      // A lone surrogate in slug throws URIError out of encodeURIComponent and
      // aborts the whole page's .map(); drop just this job (the trailing
      // .filter(Boolean) removes the null).
      const encodedSlug = safeEncodeURIComponent(slug);
      if (encodedSlug === null) return null;
      const job = {
        title,
        url: `${origin}/jobs/${encodedSlug}`,
        company: String(d.hiring_organization || entry.name || '').trim(),
        location: d.full_location || [d.city, d.country].filter(Boolean).join(', '),
      };
      const postedAt = postedDateMs(d.posted_date);
      if (postedAt !== undefined) job.postedAt = postedAt;
      return job;
    })
    .filter(Boolean);
}

/** @type {Provider} */
export default {
  id: 'jibeapply',

  detect(entry) {
    const url = entry.careers_url;
    if (typeof url !== 'string') return null;
    const apiUrl = toApiUrl(url);
    if (!apiUrl) return null;
    return { url: apiUrl };
  },

  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (typeof url !== 'string' || !url) throw new Error('jibeapply: careers_url required');

    // Prefer an explicit entry.api (allows iCIMS-hosted, branded JibeApply sites
    // that share the same JSON schema but aren't on jibeapply.com).
    const apiUrl = (typeof entry.api === 'string' && validateExplicitApi(entry.api))
      || toApiUrl(url);
    if (!apiUrl) throw new Error(`jibeapply: cannot derive API URL for ${entry.name}`);
    const first = await fetchJsonWithRetry(ctx, apiUrl, { redirect: 'error' });
    const total = first.totalCount ?? 0;
    // Use the actual number of items returned as page size — some implementations
    // set `count` to the total rather than the per-page count.
    const pageSize = first.jobs?.length || first.count || DEFAULT_PAGE_SIZE;
    const allJobs = [...(first.jobs ?? [])];
    // Set when the board is cut short (page cap or a failed page), so a caller can tell a
    // partial board from a complete one without reading stderr (the workdayTruncated convention).
    let truncated = false;
    let stopReason = null;
    let lastError = null;

    if (total > pageSize && pageSize > 0) {
      const maxPages = resolveMaxPages(entry);
      const pages = Math.min(Math.ceil(total / pageSize), maxPages);
      // Sequential, not concurrent (mirrors providers/4dayweek.mjs, thehub.mjs,
      // arbeitnow.mjs, workday.mjs) — a single tenant's API has no reason to
      // receive a burst of parallel requests, and a mid-run failure stops
      // cleanly with whatever pages were already gathered instead of
      // discarding them (Promise.all would fail the whole batch on one error).
      for (let page = 2; page <= pages; page++) {
        const u2 = new URL(apiUrl);
        u2.searchParams.set('page', String(page));
        let json;
        try {
          json = await fetchJsonWithRetry(ctx, u2.toString(), { redirect: 'error' });
        } catch (err) {
          console.error(`⚠️  jibeapply: ${entry.name} page ${page} fetch failed — ${err.message} (returning ${allJobs.length} jobs fetched so far)`);
          truncated = true;
          stopReason = err.status === 429 ? 'rate_limit' : err.status >= 500 ? 'server_error' : 'fetch_error';
          lastError = err;
          break;
        }
        allJobs.push(...(json.jobs ?? []));
      }

      // The cap is silent by design (it's a safety net, not a working limit),
      // but a tenant that actually exceeds it needs to be surfaced —
      // otherwise the user has no way to notice postings are missing from
      // their scan.
      if (Math.ceil(total / pageSize) > maxPages && !stopReason) {
        truncated = true;
        stopReason ??= 'page_cap';
        console.error(
          `⚠️  jibeapply: ${entry.name} has more postings than max_pages allows ` +
          `(fetched ${allJobs.length} of ${total}) — ` +
          `set max_pages on this portal entry to raise the cap (current: ${maxPages})`,
        );
      }
    }

    const result = parseJibeapplyResponse({ jobs: allJobs }, entry);
    if (truncated) {
      /** @type {any} */ (result).jibeapplyTruncated = true;
      Object.defineProperty(result, 'coverage', { value: {
        complete: false, provider: 'jibeapply', reason: stopReason, fetched: result.length,
        total, resumable: false,
        ...(lastError?.retryAt ? { retry_at: new Date(lastError.retryAt).toISOString() } : {}),
      } });
    }
    return result;
  },
};
