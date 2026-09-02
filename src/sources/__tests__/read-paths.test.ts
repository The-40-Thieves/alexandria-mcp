import assert from 'node:assert/strict';
import test from 'node:test';
import { type DnsLookupAll, dnsResolver } from '../../web/fetchTier.ts';
import { federalRegisterRead } from '../federalregister.ts';
import { gdeltRead } from '../gdelt.ts';
import { mdnRead } from '../mdn.ts';
import { nhkRead } from '../nhk.ts';
import { pepsRead } from '../peps.ts';

// Five sources whose read() goes through a network fetch (either the
// fetchTier tier chain, or a direct fetchJSON/fetchText call for
// federalregister) and degrades to metadata-only on failure rather than
// throwing, the same convention as kinds/rss.ts. Every fetch is mocked, and
// DNS is fixed to a public address so none of this depends on a live
// endpoint (see fetchTier.test.ts for the same dnsResolver pattern).
//
// Article HTML long enough for defuddle's tier-1 extraction (>= the
// fetchTier MIN_TEXT_CHARS threshold of 500 chars).
const ARTICLE_HTML = `<!doctype html><html><head><title>Full Article</title></head><body><article><p>${'Full text content sentence. '.repeat(40)}</p></article></body></html>`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

test('read-paths fixtures', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  const originalEnv = { ...process.env };

  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) satisfies DnsLookupAll;
  delete process.env.JINA_API_KEY;
  delete process.env.ALEXANDRIA_JINA_READER;
  delete process.env.CRAWL4AI_URL;

  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
    process.env = originalEnv;
  });

  await t.test('federalregister', async (t) => {
    const metaUrl = 'https://www.federalregister.gov/api/v1/documents/2026-08979.json';
    const meta = {
      title: 'Privacy Act Regulations',
      publication_date: '2026-05-06',
      html_url:
        'https://www.federalregister.gov/documents/2026/05/06/2026-08979/privacy-act-regulations',
      raw_text_url: 'https://www.federalregister.gov/documents/full_text/2026-08979.txt',
    };

    await t.test('returns text via a direct raw_text_url fetch', async () => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === metaUrl) return jsonResponse(meta);
        if (url === meta.raw_text_url)
          return new Response('The regulation full text.', { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await federalRegisterRead('2026-08979');
      assert.equal(result.metadataOnly, undefined);
      assert.equal(result.externalUrl, meta.html_url);
      assert.match(result.text ?? '', /regulation full text/);
    });

    await t.test('falls back to metadata when the raw_text_url fetch fails', async () => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === metaUrl) return jsonResponse(meta);
        if (url === meta.raw_text_url) return new Response('server error', { status: 500 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await federalRegisterRead('2026-08979');
      assert.equal(result.metadataOnly, true);
      // The catch block falls back to the constructed documents/{id} URL,
      // not doc.html_url: that field is only read inside the try block,
      // which a raw_text_url fetch failure never reaches.
      assert.equal(result.externalUrl, 'https://www.federalregister.gov/documents/2026-08979');
      assert.match(result.note ?? '', /Full-text fetch failed/);
    });
  });

  await t.test('gdelt', async (t) => {
    const articleUrl = 'https://example.com/news/some-article';

    await t.test('returns text via the fetch tier', async () => {
      globalThis.fetch = (async () => htmlResponse(ARTICLE_HTML)) as typeof fetch;
      const result = await gdeltRead(articleUrl);
      assert.equal(result.metadataOnly, undefined);
      assert.equal(result.externalUrl, articleUrl);
      assert.match(result.text ?? '', /Full text content sentence/);
    });

    await t.test('falls back to metadata when the tier fails', async () => {
      globalThis.fetch = (async () =>
        new Response('server error', { status: 500 })) as typeof fetch;
      const result = await gdeltRead(articleUrl);
      assert.equal(result.metadataOnly, true);
      assert.equal(result.externalUrl, articleUrl);
      assert.match(result.note ?? '', /Full-text fetch failed/);
    });
  });

  await t.test('mdn', async (t) => {
    const id = '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array';

    await t.test('returns text via the fetch tier', async () => {
      globalThis.fetch = (async () => htmlResponse(ARTICLE_HTML)) as typeof fetch;
      const result = await mdnRead(id);
      assert.equal(result.metadataOnly, undefined);
      assert.equal(result.externalUrl, `https://developer.mozilla.org${id}`);
      assert.match(result.text ?? '', /Full text content sentence/);
    });

    await t.test('falls back to metadata when the tier fails', async () => {
      globalThis.fetch = (async () =>
        new Response('server error', { status: 500 })) as typeof fetch;
      const result = await mdnRead(id);
      assert.equal(result.metadataOnly, true);
      assert.equal(result.externalUrl, `https://developer.mozilla.org${id}`);
      assert.match(result.note ?? '', /Full-text fetch failed/);
    });
  });

  await t.test('nhk', async (t) => {
    const id = 'https://www3.nhk.or.jp/nhkworld/en/news/20260902_N03/';

    await t.test('returns text via the fetch tier', async () => {
      globalThis.fetch = (async () => htmlResponse(ARTICLE_HTML)) as typeof fetch;
      const result = await nhkRead(id);
      assert.equal(result.metadataOnly, undefined);
      assert.equal(result.externalUrl, id);
      assert.match(result.text ?? '', /Full text content sentence/);
    });

    await t.test('falls back to metadata when the tier fails', async () => {
      globalThis.fetch = (async () =>
        new Response('server error', { status: 500 })) as typeof fetch;
      const result = await nhkRead(id);
      assert.equal(result.metadataOnly, true);
      assert.equal(result.externalUrl, id);
      assert.match(result.note ?? '', /Full-text fetch failed/);
    });
  });

  await t.test('peps', async (t) => {
    const indexUrl = 'https://peps.python.org/api/peps.json';
    const pepUrl = 'https://peps.python.org/pep-0008/';
    const index = {
      '8': {
        number: 8,
        title: 'Style Guide for Python Code',
        author_names: ['Guido van Rossum'],
        created: '05-Jul-2001',
        url: pepUrl,
      },
    };

    await t.test('returns text via the fetch tier', async () => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === indexUrl) return jsonResponse(index);
        if (url === pepUrl) return htmlResponse(ARTICLE_HTML);
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await pepsRead('PEP 8');
      assert.equal(result.metadataOnly, undefined);
      assert.equal(result.externalUrl, pepUrl);
      assert.match(result.text ?? '', /Full text content sentence/);
    });

    await t.test('falls back to metadata when the tier fails', async () => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === indexUrl) return jsonResponse(index);
        if (url === pepUrl) return new Response('server error', { status: 500 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await pepsRead('PEP 8');
      assert.equal(result.metadataOnly, true);
      assert.equal(result.externalUrl, pepUrl);
      assert.match(result.note ?? '', /Full-text fetch failed/);
    });
  });
});
