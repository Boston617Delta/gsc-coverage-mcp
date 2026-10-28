import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { API_PAGE_SIZE, fetchAllRows, searchAnalytics } from '../src/gsc.js';

// Fake property with `total` query rows; every row has 1 click, 10 impressions.
// Totals include extra anonymised clicks the rows never show.
function fakeClient(total, { anonymisedClicks = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(_site, body) {
      calls.push(body);
      if (!body.dimensions) {
        return [{ clicks: total + anonymisedClicks, impressions: total * 10 + anonymisedClicks * 10 }];
      }
      const start = body.startRow ?? 0;
      const n = Math.max(0, Math.min(body.rowLimit, total - start));
      return Array.from({ length: n }, (_, i) => ({
        keys: [`q${start + i}`],
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 5.123,
      }));
    },
  };
}

const base = { siteUrl: 'sc-domain:example.com', startDate: '2026-09-01', endDate: '2026-09-30', dimensions: ['query'] };

test('pages past the 25,000-row cap until the API runs dry', async () => {
  const client = fakeClient(60000);
  const pull = await fetchAllRows(client, base.siteUrl, base);
  assert.equal(pull.rows.length, 60000);
  assert.equal(pull.pages, 3);
  assert.equal(pull.apiExhausted, true);
  assert.deepEqual(client.calls.map((c) => c.startRow), [0, 25000, 50000]);
});

test('exactly one full page triggers a second request', async () => {
  const client = fakeClient(API_PAGE_SIZE);
  const pull = await fetchAllRows(client, base.siteUrl, base);
  assert.equal(pull.rows.length, API_PAGE_SIZE);
  assert.equal(pull.pages, 2);
  assert.equal(pull.hitMaxRows, false);
});

test('flags truncation when maxRows stops the pull early', async () => {
  const client = fakeClient(60000);
  const pull = await fetchAllRows(client, base.siteUrl, { ...base, maxRows: 30000 });
  assert.equal(pull.rows.length, 30000);
  assert.equal(pull.hitMaxRows, true);
  assert.deepEqual(client.calls.map((c) => c.rowLimit), [25000, 5000]);
});

test('reports click coverage against property totals', async () => {
  const client = fakeClient(300, { anonymisedClicks: 200 });
  const res = await searchAnalytics(client, base);
  assert.equal(res.rows.length, 300);
  assert.equal(res.coverage.propertyTotals.clicks, 500);
  assert.equal(res.coverage.clickCoveragePct, 60);
  assert.equal(res.coverage.truncated, false);
  assert.ok(res.coverage.notes.some((n) => n.includes('anonymised')));
  assert.equal(res.rows[0].ctr, 10);
});

test('large pulls go to a file with an inline preview', async () => {
  const client = fakeClient(1200);
  const outputFile = join(tmpdir(), `gsc-coverage-test-${Date.now()}.csv`);
  const res = await searchAnalytics(client, { ...base, outputFile, previewRows: 5 });
  assert.equal(res.file, outputFile);
  assert.equal(res.preview.length, 5);
  const lines = (await readFile(outputFile, 'utf8')).trim().split('\n');
  assert.equal(lines[0], 'query,clicks,impressions,ctr,position');
  assert.equal(lines.length, 1201);
});

test('filters are sent to both the paged pull and the totals pull', async () => {
  const client = fakeClient(10);
  const filters = [{ dimension: 'page', operator: 'contains', expression: '/blog/' }];
  await searchAnalytics(client, { ...base, filters });
  for (const call of client.calls) {
    assert.deepEqual(call.dimensionFilterGroups, [{ groupType: 'and', filters }]);
  }
});
