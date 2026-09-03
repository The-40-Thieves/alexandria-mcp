import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeDatacite } from '../datacite.ts';
import { getAdapter } from '../registry.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

type DataciteItem = Parameters<typeof normalizeDatacite>[0];

const searchFixture = fixture('datacite-search.json') as { data: DataciteItem[] };
const workFixture = fixture('datacite-work.json') as { data: DataciteItem };

test('normalizeDatacite', () => {
  const out = normalizeDatacite(searchFixture.data[0]);
  assert.equal(out.id, '10.25434/elia-ines_phd2021');
  assert.equal(out.source, 'datacite');
  assert.equal(out.title, 'SNAI1 target genes in myoblasts');
  assert.deepEqual(out.authors, ['Elia, Ines']);
  assert.equal(out.year, 2021);
  assert.equal(out.language, 'en');
  assert.match(out.description ?? '', /SNAI proteins/);
});

test('datacite adapter', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('search() builds the query URL and maps results', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.pathname, '/dois');
      assert.equal(parsed.searchParams.get('query'), 'CRISPR');
      return new Response(JSON.stringify(searchFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const out = await getAdapter('datacite').search('CRISPR', 2);
    assert.equal(out.length, 2);
  });

  await t.test('read() returns the abstract as text, truncation-wrapped', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.match(String(url), /\/dois\/10\.25434%2Felia-ines_phd2021$/);
      return new Response(JSON.stringify(workFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await getAdapter('datacite').read('10.25434/elia-ines_phd2021');
    assert.equal(result.title, 'SNAI1 target genes in myoblasts');
    assert.match(result.text ?? '', /SNAI proteins/);
    assert.equal(result.truncated, false);
  });

  await t.test('read() throws for a missing record', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: null }), { status: 200 })) as typeof fetch;
    await assert.rejects(
      () => getAdapter('datacite').read('10.0000/nonexistent'),
      /DataCite record not found/,
    );
  });
});
