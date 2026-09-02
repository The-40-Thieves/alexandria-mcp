import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { devtoSearch, normalizeDevtoArticle, normalizeDevtoFeedResult } from '../devto.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/devto-articles.json'), 'utf8'),
);

test('normalizeDevtoArticle', async (t) => {
  await t.test('maps a tag-search article to a LibraryResult', () => {
    const out = normalizeDevtoArticle(fixture[0]);
    assert.equal(out.id, '4549831');
    assert.equal(out.source, 'devto');
    assert.ok(out.title.includes('Rust hot path'));
    assert.deepEqual(out.authors, ['Vitalii Buhaiov']);
    assert.ok(out.description);
    assert.equal(out.year, 2026);
    assert.ok(out.url?.startsWith('https://dev.to/'));
  });
});

test('normalizeDevtoFeedResult', async (t) => {
  await t.test('builds an absolute URL from a relative path', () => {
    const out = normalizeDevtoFeedResult({
      id: 1,
      title: 'Feed search hit',
      path: '/someone/a-post-abc',
      user: { name: 'Someone' },
      published_at_int: 1750000000, // 2025-06-15, safely mid-year across time zones
    });
    assert.equal(out.url, 'https://dev.to/someone/a-post-abc');
    assert.equal(out.year, 2025);
  });
});

test('devtoSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('uses the tag-filtered articles endpoint for a single-token query', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await devtoSearch('rust', 5);
    assert.ok(calledUrl.startsWith('https://dev.to/api/articles?tag=rust'));
    assert.equal(out.length, 2);
  });

  await t.test('uses the site search feed for a multi-token query', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }) as typeof fetch;
    await devtoSearch('rust async', 5);
    assert.ok(calledUrl.startsWith('https://dev.to/search/feed_content?'));
  });
});
