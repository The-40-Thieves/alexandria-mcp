import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeW3c, w3cSearch } from '../w3c.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/w3c-specifications.json'), 'utf8'),
);

test('normalizeW3c', async (t) => {
  await t.test('maps a spec to a LibraryResult, stripping HTML from the description', () => {
    const out = normalizeW3c(fixture._embedded.specifications[0]);
    assert.equal(out.id, 'SMIL2-AuthExt');
    assert.equal(out.source, 'w3c');
    assert.ok(out.title.includes('SMIL 2.0'));
    assert.ok(out.description);
    assert.ok(!out.description?.includes('<p>'));
    assert.equal(out.url, 'https://api.w3.org/specifications/SMIL2-AuthExt/versions/20030512');
  });
});

test('w3cSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('downloads the catalog once and filters by title token', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await w3cSearch('SMIL', 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'SMIL2-AuthExt');
    await w3cSearch('multimedia', 5);
    assert.equal(calls, 1);
  });
});
