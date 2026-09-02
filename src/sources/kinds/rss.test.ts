import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { defineRssSource, parseFeedItems } from './rss.js';

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), 'eval/fixtures/rss', name), 'utf8');
}

test('parseFeedItems', async (t) => {
  await t.test('normalizes RSS 2.0 items', () => {
    const items = parseFeedItems(fixture('rss2.xml'));
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => i.title),
      ['Older advisory about a buffer overflow', 'New critical remote code execution flaw'],
    );
    assert.equal(items[1].link, 'https://example.org/advisory/2');
    assert.equal(items[1].id, 'https://example.org/advisory/2');
    assert.deepEqual(items[1].authors, ['New Author']);
    assert.match(items[1].summary ?? '', /remote code execution/);
    assert.equal(items[1].published, 'Tue, 01 Sep 2026 09:00:00 GMT');
  });

  await t.test('normalizes Atom entries', () => {
    const items = parseFeedItems(fixture('atom.xml'));
    assert.equal(items.length, 2);
    assert.equal(items[1].title, 'New dispatch on election results');
    assert.equal(items[1].link, 'https://example.org/atom/2');
    assert.equal(items[1].id, 'https://example.org/atom/2');
    assert.deepEqual(items[1].authors, ['New Reporter']);
    assert.equal(items[1].published, '2026-09-01T09:00:00Z');
  });

  await t.test('normalizes RDF items', () => {
    const items = parseFeedItems(fixture('rdf.xml'));
    assert.equal(items.length, 2);
    assert.equal(items[1].title, 'New headlines roundup');
    assert.equal(items[1].link, 'https://example.org/rdf/2');
    assert.deepEqual(items[1].authors, ['New Editor']);
    assert.equal(items[1].published, '2026-09-01T09:00:00Z');
  });

  await t.test('strips HTML tags and decodes entities out of the summary', () => {
    const items = parseFeedItems(fixture('html-description.xml'));
    assert.equal(items.length, 1);
    assert.doesNotMatch(items[0].summary ?? '', /[<>]/);
    assert.match(items[0].summary ?? '', /quantum computing/);
  });
});

test('defineRssSource', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(body: string) {
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/rss+xml' },
      })) as typeof fetch;
  }

  await t.test('search returns newest-first up to limit on an empty query', async () => {
    stubFetch(fixture('rss2.xml'));
    defineRssSource({
      name: 'test-rss-empty-query',
      url: 'https://example.org/feed.xml',
      description: 'Test feed',
      cluster: 'security',
      homepage: 'https://example.org',
    });
    const results = await getAdapter('test-rss-empty-query').search('', 10);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, 'New critical remote code execution flaw');
    assert.equal(results[0].id, 'https://example.org/advisory/2');
    assert.equal(results[0].url, 'https://example.org/advisory/2');
    assert.equal(results[0].source, 'test-rss-empty-query');
  });

  await t.test('search filters by case-insensitive token match on title+summary', async () => {
    stubFetch(fixture('rss2.xml'));
    defineRssSource({
      name: 'test-rss-filtered',
      url: 'https://example.org/feed.xml',
      description: 'Test feed',
      cluster: 'security',
      homepage: 'https://example.org',
    });
    const results = await getAdapter('test-rss-filtered').search('BUFFER overflow', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Older advisory about a buffer overflow');
  });

  await t.test('search respects limit', async () => {
    stubFetch(fixture('rss2.xml'));
    defineRssSource({
      name: 'test-rss-limit',
      url: 'https://example.org/feed.xml',
      description: 'Test feed',
      cluster: 'security',
      homepage: 'https://example.org',
    });
    const results = await getAdapter('test-rss-limit').search('', 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'New critical remote code execution flaw');
  });

  await t.test('read returns metadataOnly with externalUrl set to the id', async () => {
    defineRssSource({
      name: 'test-rss-read',
      url: 'https://example.org/feed.xml',
      description: 'Test feed',
      cluster: 'security',
      homepage: 'https://example.org',
    });
    const result = await getAdapter('test-rss-read').read('https://example.org/advisory/2');
    assert.equal(result.metadataOnly, true);
    assert.equal(result.externalUrl, 'https://example.org/advisory/2');
  });

  await t.test(
    'search matches a token inside HTML markup and returns a tag-free description',
    async () => {
      stubFetch(fixture('html-description.xml'));
      defineRssSource({
        name: 'test-rss-html-description',
        url: 'https://example.org/feed.xml',
        description: 'Test feed',
        cluster: 'news_global',
        homepage: 'https://example.org',
      });
      const results = await getAdapter('test-rss-html-description').search('quantum', 10);
      assert.equal(results.length, 1);
      assert.doesNotMatch(results[0].description ?? '', /[<>]/);
      assert.match(results[0].description ?? '', /quantum computing/);
    },
  );

  await t.test('registers with the RSS kind defaults', async () => {
    defineRssSource({
      name: 'test-rss-region',
      url: 'https://example.org/feed.xml',
      description: 'Test feed',
      cluster: 'news_regional',
      region: 'Testland',
      homepage: 'https://example.org',
    });
    const { listSources } = await import('../registry.js');
    const meta = listSources().find((s) => s.name === 'test-rss-region');
    assert.ok(meta);
    assert.equal(meta?.kind, 'rss');
    assert.equal(meta?.freshness, 'realtime');
    assert.equal(meta?.timeoutMs, 20000);
    assert.equal(meta?.supportsIngest, false);
    assert.match(meta?.description ?? '', /Testland/);
  });
});
