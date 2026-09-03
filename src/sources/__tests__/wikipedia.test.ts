import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { type DnsLookupAll, dnsResolver } from '../../web/fetchTier.ts';
import { getAdapter } from '../registry.ts';
import { normalizeWikipediaPage, wikipediaRead, wikipediaSearch } from '../wikipedia.ts';

const searchFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/wikipedia-search.json'), 'utf8'),
);
const summaryFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/wikipedia-summary.json'), 'utf8'),
);

// Long enough for defuddle's tier-1 extraction (>= fetchTier's 500-char
// MIN_TEXT_CHARS threshold).
const ARTICLE_HTML = `<!doctype html><html><head><title>Alan Turing</title></head><body><article><p>${'Alan Turing was an English mathematician and computer scientist. '.repeat(20)}</p></article></body></html>`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeWikipediaPage', () => {
  const out = normalizeWikipediaPage(searchFixture.pages[0]);
  assert.equal(out.id, 'Alan_Turing');
  assert.equal(out.source, 'wikipedia');
  assert.equal(out.title, 'Alan Turing');
  assert.equal(out.hasFullText, true);
  assert.equal(out.previewUrl, 'https://en.wikipedia.org/wiki/Alan_Turing');
  // The excerpt's <span class="searchmatch"> markup is stripped.
  assert.ok(!out.description?.includes('<span'));
  assert.match(out.description ?? '', /Turing\s+machine/);
});

test('wikipediaSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('maps the REST search/page response', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.match(String(url), /\/w\/rest\.php\/v1\/search\/page\?/);
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await wikipediaSearch('Turing', 5);
    assert.equal(out.length, 2);
    assert.equal(out[1].id, 'Turing_Award');
  });
});

test('wikipediaRead', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) satisfies DnsLookupAll;
  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
  });

  await t.test('combines the summary title with the mobile-html full text', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/page/summary/')) return jsonResponse(summaryFixture);
      if (url.includes('/page/mobile-html/')) {
        return new Response(ARTICLE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const result = await wikipediaRead('Alan_Turing');
    assert.equal(result.title, 'Alan Turing');
    assert.match(result.text, /Alan Turing was an English mathematician/);
  });

  await t.test('falls back to the summary extract when the full-text fetch fails', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/page/summary/')) return jsonResponse(summaryFixture);
      if (url.includes('/page/mobile-html/')) return new Response('error', { status: 500 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const result = await wikipediaRead('Alan_Turing');
    assert.equal(result.title, 'Alan Turing');
    assert.equal(result.text, summaryFixture.extract);
  });

  await t.test('propagates a "not found" error from the summary fetch', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await assert.rejects(() => wikipediaRead('Nonexistent_Page_Xyz'), /HTTP 404/);
  });
});

test('wikipedia adapter is registered with attribution ingest policy', async () => {
  const { listSources } = await import('../registry.ts');
  const meta = listSources().find((s) => s.name === 'wikipedia');
  assert.ok(meta);
  assert.equal(meta?.ingestPolicy, 'attribution');
  assert.equal(meta?.cluster, 'web');
  assert.ok(getAdapter('wikipedia'));
});
