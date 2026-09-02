import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizePep, pepsSearch } from '../peps.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/peps-index.json'), 'utf8'),
);

test('normalizePep', async (t) => {
  await t.test('maps a PEP entry to a LibraryResult', () => {
    const out = normalizePep(fixture['8']);
    assert.equal(out.id, 'PEP 8');
    assert.equal(out.source, 'peps');
    assert.equal(out.title, 'Style Guide for Python Code');
    assert.ok(out.authors.includes('Guido van Rossum'));
    assert.equal(out.year, 2001);
    assert.equal(out.url, 'https://peps.python.org/pep-0008/');
  });
});

test('pepsSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('downloads the index once and filters by number or title token', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await pepsSearch('style guide', 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'PEP 8');
    await pepsSearch('purpose', 5);
    assert.equal(calls, 1); // cached after the first download
  });
});
