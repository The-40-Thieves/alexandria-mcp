import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { type DnsLookupAll, dnsResolver } from '../../web/fetchTier.ts';
import { eurlexRead, eurlexSearch, normalizeEurlexBinding } from '../eurlex.ts';
import { getAdapter } from '../registry.ts';

const searchFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/eurlex-search.json'), 'utf8'),
);

const DOC_HTML = `<!doctype html><html><head><title>Data Protection Act 1998</title></head><body><article><p>${'This Act makes provision for the regulation of the processing of information relating to individuals. '.repeat(10)}</p></article></body></html>`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeEurlexBinding', () => {
  const out = normalizeEurlexBinding(searchFixture.results.bindings[1]);
  assert.ok(out);
  assert.equal(out?.id, '72002F0465GBR_226696');
  assert.equal(out?.source, 'eurlex');
  assert.equal(out?.title, 'Data Protection Act 1998');
  assert.equal(out?.language, 'en');
  assert.equal(
    out?.previewUrl,
    'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:72002F0465GBR_226696',
  );
});

test('normalizeEurlexBinding drops a binding missing a celex or title', () => {
  assert.equal(normalizeEurlexBinding({}), null);
});

test('eurlexSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('embeds the query as a SPARQL CONTAINS filter', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      const query = parsed.searchParams.get('query') ?? '';
      assert.match(query, /CONTAINS\(LCASE\(STR\(\?title\)\), "data protection"\)/);
      assert.match(query, /LIMIT 3/);
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await eurlexSearch('Data Protection', 3);
    assert.equal(out.length, 3);
  });

  await t.test('escapes a double quote in the query so it cannot break the filter', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      const query = parsed.searchParams.get('query') ?? '';
      assert.match(query, /CONTAINS\(LCASE\(STR\(\?title\)\), "foo\\"bar"\)/);
      return jsonResponse({ results: { bindings: [] } });
    }) as typeof fetch;
    await eurlexSearch('foo"bar', 5);
  });
});

test('eurlexRead', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) satisfies DnsLookupAll;
  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
  });

  await t.test('fetches the stable CELEX document URL via the fetch tier', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(
        String(url),
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:72002F0465GBR_226696',
      );
      return new Response(DOC_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch;
    const result = await eurlexRead('72002F0465GBR_226696');
    assert.equal(result.metadataOnly, undefined);
    assert.match(result.text ?? '', /regulation of the processing/);
  });

  await t.test('degrades to metadata-only when the fetch fails', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as typeof fetch;
    const result = await eurlexRead('72002F0465GBR_226696');
    assert.equal(result.metadataOnly, true);
    assert.match(result.note ?? '', /Full-text fetch failed/);
  });
});

test('eurlex adapter is registered', () => {
  assert.ok(getAdapter('eurlex'));
});
