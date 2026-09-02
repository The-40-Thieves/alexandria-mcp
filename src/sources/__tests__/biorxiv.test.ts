import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { biorxivSearch, matchesQuery } from '../biorxiv.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/biorxiv-search.json'), 'utf8'),
);

test('matchesQuery', async (t) => {
  await t.test('matches title/abstract case-insensitively (all terms required)', () => {
    assert.equal(matchesQuery(fixture.collection[0], ['ect']), true);
    assert.equal(matchesQuery(fixture.collection[0], ['ect', 'nonexistentterm']), false);
  });
});

test('biorxivSearch pages the last 7 days and filters client-side (fixture-mocked)', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls += 1;
    assert.match(String(url), /\/details\/biorxiv\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}\/0/);
    // Only one page's worth of data (5 entries) — collection.length < PAGE_SIZE
    // (30) tells biorxivSearch there is no next page.
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as typeof fetch;

  try {
    const out = await biorxivSearch('ect', 5);
    assert.ok(out.length > 0);
    assert.equal(calls, 1); // stopped after the first (short) page
    assert.equal(out[0].id, '10.64898/2026.08.20.745969');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
