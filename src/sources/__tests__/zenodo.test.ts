import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeZenodo, zenodoSearch } from '../zenodo.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/zenodo-search.json'), 'utf8'),
);

test('normalizeZenodo', async (t) => {
  await t.test('maps hits.hits[] and strips HTML from the description', () => {
    const out = normalizeZenodo(fixture);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '13235113');
    assert.equal(out[0].previewUrl, 'https://doi.org/10.5281/zenodo.13235113');
    assert.equal(out[0].year, 2024);
    assert.doesNotMatch(out[0].description ?? '', /<p>/);
  });
});

test('zenodoSearch honors Retry-After on a 429 (single retry)', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    }
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as typeof fetch;

  try {
    const out = await zenodoSearch('plastic waste', 2);
    assert.equal(out.length, 2);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
