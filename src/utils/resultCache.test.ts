import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheKey, parseTtlMs, ResultCache, routingCacheKey } from './resultCache.ts';
import { MemoryStateStore } from './stateStore.ts';

test('resultCache', async (t) => {
  await t.test('returns undefined on miss', () => {
    const c = new ResultCache<number>(1000);
    assert.equal(c.get('missing'), undefined);
  });

  await t.test('returns the stored value before expiry', () => {
    const c = new ResultCache<number>(1000);
    c.set('k', 42, 0);
    assert.equal(c.get('k', 500), 42);
  });

  await t.test('expires entries after ttlMs', () => {
    const c = new ResultCache<number>(1000);
    c.set('k', 42, 0);
    assert.equal(c.get('k', 1001), undefined);
  });

  await t.test('a ttl of 0 disables caching', () => {
    const c = new ResultCache<number>(0);
    c.set('k', 42, 0);
    assert.equal(c.get('k', 0), undefined);
  });

  await t.test('evicts the oldest entry once max is exceeded', () => {
    const c = new ResultCache<number>(1000, new MemoryStateStore(2));
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    c.set('c', 3, 0);
    assert.equal(c.get('a', 0), undefined);
    assert.equal(c.get('b', 0), 2);
    assert.equal(c.get('c', 0), 3);
  });

  await t.test('cacheKey normalizes whitespace and case', () => {
    assert.equal(
      cacheKey('arxiv', '  Attention   Is All  ', 5),
      cacheKey('arxiv', 'attention is all', 5),
    );
  });

  await t.test('cacheKey distinguishes source and limit', () => {
    assert.notEqual(cacheKey('a', 'q', 5), cacheKey('b', 'q', 5));
    assert.notEqual(cacheKey('a', 'q', 5), cacheKey('a', 'q', 10));
  });

  await t.test(
    'parseTtlMs falls back to the default on a non-numeric value instead of yielding NaN',
    () => {
      assert.equal(parseTtlMs('not-a-number', 600_000), 600_000);
    },
  );

  await t.test('routingCacheKey normalizes whitespace and case', () => {
    assert.equal(
      routingCacheKey('  Attention   Is All  ', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
      routingCacheKey('attention is all', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
    );
  });

  await t.test('routingCacheKey distinguishes max_sources', () => {
    assert.notEqual(
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
      routingCacheKey('q', 6, 'embeddings', 0.4, 'gpt-4o-mini', false),
    );
  });

  await t.test('routingCacheKey distinguishes stage1 mode', () => {
    assert.notEqual(
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
      routingCacheKey('q', 5, 'bm25', 0.4, 'gpt-4o-mini', false),
    );
  });

  await t.test('routingCacheKey distinguishes the effective skip margin', () => {
    assert.notEqual(
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
      routingCacheKey('q', 5, 'embeddings', 0.3, 'gpt-4o-mini', false),
    );
  });

  await t.test('routingCacheKey distinguishes the router model', () => {
    assert.notEqual(
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o', false),
    );
  });

  await t.test('routingCacheKey distinguishes multi-query on vs off', () => {
    assert.notEqual(
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
      routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', true),
    );
  });

  await t.test('routingCacheKey cannot collide with a cacheKey for a plausible source name', () => {
    // searchCache and routingCache share one physical stateStore table
    // (both go through defaultStateStore), so a cacheKey(source, ...) and
    // a routingCacheKey(...) must never produce the identical string for
    // any registry source name this repo would plausibly register. A
    // shorter prefix like "route" would collide the moment a source were
    // literally named "route" (cacheKey('route', q, n) ===
    // routingCacheKey(q, n)); "routing-decision" is not a registry source
    // name shape (registry names are single short words, per every source
    // in src/sources/*.ts).
    for (const source of ['route', 'router', 'arxiv', 'gutenberg', 'routing', 'decision']) {
      assert.notEqual(
        routingCacheKey('q', 5, 'embeddings', 0.4, 'gpt-4o-mini', false),
        cacheKey(source, 'q', 5),
      );
    }
  });
});
