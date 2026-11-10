import { test } from 'node:test';
import assert from 'node:assert/strict';
import workday from '../../providers/workday.mjs';

const entry = { name: 'Synthetic', careers_url: 'https://synthetic.wd1.myworkdayjobs.com/careers' };

test('Workday keyword search is preserved through every page', async () => {
  const bodies = [];
  const jobs = await workday.fetch({ ...entry, workday: { search_text: ' software ' } }, {
    sleep: async () => {},
    fetchJson: async (_url, opts) => {
      const body = JSON.parse(opts.body); bodies.push(body);
      return { total: 41, jobPostings: Array.from({ length: Math.min(20, 41 - body.offset) }, (_, i) => ({ title: 'Software Engineer', externalPath: `/job/test/req${body.offset + i}` })) };
    },
  });
  assert.equal(jobs.length, 41);
  assert.deepEqual(bodies.map(body => body.offset), [0, 20, 40]);
  assert.ok(bodies.every(body => body.searchText === 'software'));
});

test('Workday default stays full-board; malformed query fails before a request', async () => {
  let query;
  await workday.fetch(entry, { fetchJson: async (_url, opts) => { query = JSON.parse(opts.body).searchText; return { total: 0, jobPostings: [] }; } });
  assert.equal(query, '');
  await assert.rejects(workday.fetch({ ...entry, workday: { search_text: 42 } }, { fetchJson: async () => assert.fail('must validate first') }), /must be a string/);
});
