import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseJibeapplyResponse } from '../../providers/jibeapply.mjs';
import { buildPostingAgeFilter } from '../../scan.mjs';

const entry = { name: 'Synthetic', careers_url: 'https://synthetic.jibeapply.com/jobs' };
const normalize = fields => parseJibeapplyResponse({ jobs: [{ data: { title: 'Engineer', slug: '1', ...fields } }] }, entry)[0];

test('Jibe preserves explicit publication dates and timezone offsets', () => {
  for (const value of ['2026-09-18', '2026-09-18T13:44:00+0000', '2026-10-14T13:44:00.000Z', '2026-11-01T23:30:00-0500', '2024-02-29']) {
    assert.equal(normalize({ posted_date: value }).postedAt, Date.parse(value), value);
  }
});

test('invalid/missing publication dates stay unknown; update dates never substitute', () => {
  for (const value of [undefined, null, '', 'not a date', '2026-02-30', '2026-13-01', '2026-11-01T24:00:00Z', '2026-11-01T12:61:00Z', '2026-11-01T12:00:00', 1790000000, {}]) {
    assert.equal(Object.hasOwn(normalize({ posted_date: value, updated_at: '2026-11-09T12:00:00Z', updated_date: '2026-11-09' }), 'postedAt'), false, String(value));
  }
});

test('the scanner age filter rejects old Jibe publication dates despite a recent update', () => {
  const age = buildPostingAgeFilter(45, Date.parse('2026-11-09T12:00:00Z'));
  for (const posted_date of ['2026-09-18T13:44:00+0000', '2026-05-27T13:44:00+0000']) {
    assert.equal(age(normalize({ posted_date, updated_at: '2026-11-09T12:00:00Z' }).postedAt), false);
  }
  assert.equal(age(normalize({ posted_date: '2026-10-14T13:44:00+0000' }).postedAt), true);
  assert.equal(age(normalize({}).postedAt), true);
});

test('actual dry-run scanner receipt filters an old Jibe posting while retaining current and unknown dates', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-jibe-dates-'));
  const scan = fileURLToPath(new URL('../../scan.mjs', import.meta.url));
  const preload = join(root, 'transport.mjs');
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config/profile.yml'), '{}\n');
    writeFileSync(join(root, 'portals.yml'), 'max_posting_age_days: 45\ntracked_companies:\n  - name: Synthetic\n    careers_url: https://synthetic.jibeapply.com/jobs\n');
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const jobs = [
      { title: 'Old Engineer', slug: 'old', posted_date: old, updated_at: recent },
      { title: 'Current Engineer', slug: 'current', posted_date: recent },
      { title: 'Unknown Date Engineer', slug: 'unknown', updated_at: recent },
    ];
    writeFileSync(preload, `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify({ totalCount: 3, jobs }))},{headers:{'content-type':'application/json'}});`);
    const result = spawnSync(process.execPath, ['--import', preload, scan, '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_PROFILE: join(root, 'config/profile.yml'), CAREER_OPS_PORTALS: join(root, 'portals.yml'), CAREER_OPS_TRACKER: '', CAREER_OPS_PIPELINE: join(root, 'pipeline.md'), CAREER_OPS_SCAN_HISTORY: join(root, 'scan-history.tsv') },
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.found, 3);
    assert.equal(receipt.filtered, 1);
    assert.deepEqual(receipt.added_urls, ['https://synthetic.jibeapply.com/jobs/current', 'https://synthetic.jibeapply.com/jobs/unknown']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
