import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dblpRead, dblpSearch, normalizeDblpHit, parseDblpBibtex } from '../dblp.ts';
import { getAdapter, listSources } from '../registry.ts';

const searchFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/dblp-search.json'), 'utf8'),
);

const BIBTEX = `@article{DBLP:journals/entropy/Edmonds25a,
  author       = {Jeff Edmonds},
  title        = {Why Turing's Computable Numbers Are Only Non-Constructively Closed
                  Under Addition},
  journal      = {Entropy},
  volume       = {28},
  year         = {2025},
  doi          = {10.3390/E28010071},
}`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('dblp adapter is paced at 1 request/second', () => {
  const meta = listSources().find((s) => s.name === 'dblp');
  assert.equal(meta?.pacing?.minIntervalMs, 1000);
});

test('normalizeDblpHit', () => {
  const out = normalizeDblpHit(searchFixture.result.hits.hit[0]);
  assert.equal(out.id, 'conf/geoindustry/YussifLUH25');
  assert.equal(out.source, 'dblp');
  assert.match(out.title, /Grid Attention Transformer/);
  assert.equal(out.authors.length, 4);
  assert.equal(out.year, 2025);
  assert.deepEqual(out.subjects, ['GeoIndustry']);
});

test('normalizeDblpHit coerces a single-author object into a one-element list', () => {
  const out = normalizeDblpHit({
    info: {
      key: 'x/y',
      title: 'Solo',
      authors: { author: { text: 'Only Author' } },
    },
  });
  assert.deepEqual(out.authors, ['Only Author']);
});

test('parseDblpBibtex', () => {
  const parsed = parseDblpBibtex(BIBTEX);
  assert.match(parsed.title, /Why Turing's Computable Numbers/);
  assert.deepEqual(parsed.authors, ['Jeff Edmonds']);
  assert.equal(parsed.year, 2025);
});

test('dblpSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('sends q/format/h and maps hits', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('q'), 'attention transformer');
      assert.equal(parsed.searchParams.get('format'), 'json');
      assert.equal(parsed.searchParams.get('h'), '2');
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await dblpSearch('attention transformer', 2);
    assert.equal(out.length, 2);
  });

  await t.test('returns no results when dblp omits the hit array', async () => {
    globalThis.fetch = (async () => jsonResponse({ result: { hits: {} } })) as typeof fetch;
    const out = await dblpSearch('zzzznonexistent', 5);
    assert.deepEqual(out, []);
  });
});

test('dblpRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('fetches the .bib citation and derives title/authors/year', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), 'https://dblp.org/rec/journals/entropy/Edmonds25a.bib');
      return new Response(BIBTEX, { status: 200 });
    }) as typeof fetch;
    const result = await dblpRead('journals/entropy/Edmonds25a');
    assert.match(result.title, /Why Turing's Computable Numbers/);
    assert.deepEqual(result.authors, ['Jeff Edmonds']);
    assert.equal(result.year, 2025);
    assert.match(result.text ?? '', /@article/);
  });

  await t.test('percent-encodes each key segment', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), 'https://dblp.org/rec/conf/some%20conf/Author25.bib');
      return new Response('@misc{x, title={T}}', { status: 200 });
    }) as typeof fetch;
    await dblpRead('conf/some conf/Author25');
  });

  await t.test('propagates a not-found error', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await assert.rejects(() => dblpRead('conf/nonexistent/X'), /HTTP 404/);
  });
});

test('dblp adapter is registered', () => {
  assert.ok(getAdapter('dblp'));
});
