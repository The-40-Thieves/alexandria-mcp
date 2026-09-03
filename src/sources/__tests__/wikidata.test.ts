import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter, listSources } from '../registry.ts';
import { normalizeWikidataEntity, wikidataSearch } from '../wikidata.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/wikidata-search.json'), 'utf8'),
);

test('normalizeWikidataEntity', () => {
  const out = normalizeWikidataEntity(fixture.search[0]);
  assert.equal(out.id, 'Q7251');
  assert.equal(out.source, 'wikidata');
  assert.equal(out.title, 'Alan Turing');
  assert.equal(out.hasFullText, false);
  assert.equal(out.previewUrl, 'https://www.wikidata.org/wiki/Q7251');
  assert.equal(out.description, 'English computer scientist (1912-1954)');
});

test('wikidataSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('maps the wbsearchentities response', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('action'), 'wbsearchentities');
      assert.equal(parsed.searchParams.get('search'), 'Turing');
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const out = await wikidataSearch('Turing', 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'Q7251');
  });
});

test('wikidata read() is a metadata-only stub (entity search only, supportsIngest: false)', async () => {
  const meta = listSources().find((s) => s.name === 'wikidata');
  assert.ok(meta);
  assert.equal(meta?.supportsIngest, false);

  const adapter = getAdapter('wikidata');
  const result = await adapter.read('Q7251');
  assert.equal(result.metadataOnly, true);
  assert.equal(result.externalUrl, 'https://www.wikidata.org/wiki/Q7251');
});
