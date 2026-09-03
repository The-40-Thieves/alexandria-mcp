import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { matchesQuery, medrxivRead, medrxivSearch } from '../medrxiv.ts';
import { getAdapter } from '../registry.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/medrxiv-search.json'), 'utf8'),
);

test('matchesQuery', async (t) => {
  await t.test('matches title/abstract case-insensitively (all terms required)', () => {
    assert.equal(matchesQuery(fixture.collection[0], ['hla']), true);
    assert.equal(matchesQuery(fixture.collection[0], ['hla', 'nonexistentterm']), false);
  });
});

test('medrxivSearch pages the last 7 days and filters client-side (fixture-mocked)', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls += 1;
    assert.match(String(url), /\/details\/medrxiv\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}\/0/);
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as typeof fetch;

  const out = await medrxivSearch('hla', 5);
  assert.ok(out.length > 0);
  assert.equal(calls, 1); // stopped after the first (short) page
  assert.equal(out[0].id, '10.64898/2026.03.27.26349549');
  assert.equal(out[0].source, 'medrxiv');
});

test('medrxivRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('returns the abstract for a known DOI', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch;
    const result = await medrxivRead('10.64898/2026.03.27.26349549');
    assert.equal(result.title, fixture.collection[0].title);
    assert.match(result.text, /major histocompatibility complex/);
  });

  await t.test('throws when the DOI is not found', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ collection: [] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => medrxivRead('10.0000/nonexistent'), /medRxiv paper not found/);
  });
});

test('medrxiv adapter is registered', () => {
  assert.ok(getAdapter('medrxiv'));
});
