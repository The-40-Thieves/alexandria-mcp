import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { defineRest } from './rest.js';

interface FakeRaw {
  items: Array<{ id: string; name: string }>;
}

function stubFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body: FakeRaw = {
      items: [
        { id: '1', name: 'first' },
        { id: '2', name: 'second' },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

test('defineRest', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  await t.test('injects query-param auth into the request URL', async () => {
    process.env.TEST_REST_QUERY_KEY = 'secret-query-value';
    const { calls } = stubFetch();
    defineRest<FakeRaw>({
      name: 'test-rest-query',
      description: 'Test',
      cluster: 'developer',
      freshness: 'static',
      homepage: 'https://example.org',
      supportsIngest: false,
      auth: { type: 'query', env: 'TEST_REST_QUERY_KEY', param: 'api_key' },
      search: {
        url: (q, limit) => `https://example.org/search?q=${q}&limit=${limit}`,
        pick: (raw) => raw.items,
        normalize: (item) => ({
          id: item.id,
          source: 'test-rest-query',
          title: item.name,
          authors: [],
          hasFullText: false,
        }),
      },
    });
    await getAdapter('test-rest-query').search('cats', 5);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('api_key'), 'secret-query-value');
    assert.equal(url.searchParams.get('q'), 'cats');
  });

  await t.test('injects header auth as the named header', async () => {
    process.env.TEST_REST_HEADER_KEY = 'secret-header-value';
    const { calls } = stubFetch();
    defineRest<FakeRaw>({
      name: 'test-rest-header',
      description: 'Test',
      cluster: 'developer',
      freshness: 'static',
      homepage: 'https://example.org',
      supportsIngest: false,
      auth: { type: 'header', env: 'TEST_REST_HEADER_KEY', header: 'X-Api-Key' },
      search: {
        url: () => 'https://example.org/search',
        pick: (raw) => raw.items,
        normalize: (item) => ({
          id: item.id,
          source: 'test-rest-header',
          title: item.name,
          authors: [],
          hasFullText: false,
        }),
      },
    });
    await getAdapter('test-rest-header').search('cats', 5);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Api-Key'], 'secret-header-value');
  });

  await t.test('injects bearer auth as an Authorization: Bearer header', async () => {
    process.env.TEST_REST_BEARER_KEY = 'secret-bearer-value';
    const { calls } = stubFetch();
    defineRest<FakeRaw>({
      name: 'test-rest-bearer',
      description: 'Test',
      cluster: 'developer',
      freshness: 'static',
      homepage: 'https://example.org',
      supportsIngest: false,
      auth: { type: 'bearer', env: 'TEST_REST_BEARER_KEY' },
      search: {
        url: () => 'https://example.org/search',
        pick: (raw) => raw.items,
        normalize: (item) => ({
          id: item.id,
          source: 'test-rest-bearer',
          title: item.name,
          authors: [],
          hasFullText: false,
        }),
      },
    });
    await getAdapter('test-rest-bearer').search('cats', 5);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer secret-bearer-value');
  });

  await t.test('throws "<name> requires <ENV>" when the declared env var is absent', async () => {
    delete process.env.TEST_REST_MISSING_KEY;
    stubFetch();
    defineRest<FakeRaw>({
      name: 'test-rest-missing',
      description: 'Test',
      cluster: 'developer',
      freshness: 'static',
      homepage: 'https://example.org',
      supportsIngest: false,
      auth: { type: 'bearer', env: 'TEST_REST_MISSING_KEY' },
      search: {
        url: () => 'https://example.org/search',
        pick: (raw) => raw.items,
        normalize: (item) => ({
          id: item.id,
          source: 'test-rest-missing',
          title: item.name,
          authors: [],
          hasFullText: false,
        }),
      },
    });
    await assert.rejects(
      () => getAdapter('test-rest-missing').search('cats', 5),
      /^Error: test-rest-missing requires TEST_REST_MISSING_KEY$/,
    );
  });

  await t.test('normalize returning null drops the item', async () => {
    stubFetch();
    defineRest<FakeRaw>({
      name: 'test-rest-drop',
      description: 'Test',
      cluster: 'developer',
      freshness: 'static',
      homepage: 'https://example.org',
      supportsIngest: false,
      search: {
        url: () => 'https://example.org/search',
        pick: (raw) => raw.items,
        normalize: (item) =>
          item.id === '2'
            ? null
            : {
                id: item.id,
                source: 'test-rest-drop',
                title: item.name,
                authors: [],
                hasFullText: false,
              },
      },
    });
    const results = await getAdapter('test-rest-drop').search('cats', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, '1');
  });

  await t.test('read() builds its own request and normalizes the raw response', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), 'https://example.org/item/42');
      return new Response(JSON.stringify({ id: '42', name: 'the item' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    defineRest<FakeRaw>({
      name: 'test-rest-read',
      description: 'Test',
      cluster: 'developer',
      freshness: 'static',
      homepage: 'https://example.org',
      supportsIngest: true,
      search: {
        url: () => 'https://example.org/search',
        pick: (raw) => raw.items,
        normalize: (item) => ({
          id: item.id,
          source: 'test-rest-read',
          title: item.name,
          authors: [],
          hasFullText: false,
        }),
      },
      read: {
        url: (id) => `https://example.org/item/${id}`,
        normalize: (raw, id) => ({ title: raw.name, authors: [], text: `text for ${id}` }),
      },
    });
    const result = await getAdapter('test-rest-read').read('42');
    assert.equal(result.title, 'the item');
    assert.equal(result.text, 'text for 42');
  });
});
