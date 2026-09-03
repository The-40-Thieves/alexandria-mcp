import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { biorxivRead, biorxivSearch, matchesQuery } from '../biorxiv.ts';

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
    // Only one page's worth of data (5 entries): collection.length < PAGE_SIZE
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

test('biorxivRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('returns the abstract and doi for a known DOI', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch;
    const result = await biorxivRead('10.64898/2026.08.20.745969');
    assert.equal(result.title, fixture.collection[0].title);
    assert.equal(result.doi, '10.64898/2026.08.20.745969');
  });

  await t.test('throws when the DOI is not found', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ collection: [] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => biorxivRead('10.0000/nonexistent'), /bioRxiv paper not found/);
  });
});
