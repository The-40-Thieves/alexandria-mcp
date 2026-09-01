import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCache, cacheKey } from './resultCache.js';

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
    const c = new ResultCache<number>(1000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    c.set('c', 3, 0);
    assert.equal(c.get('a', 0), undefined);
    assert.equal(c.get('b', 0), 2);
    assert.equal(c.get('c', 0), 3);
  });

  await t.test('cacheKey normalizes whitespace and case', () => {
    assert.equal(cacheKey('arxiv', '  Attention   Is All  ', 5), cacheKey('arxiv', 'attention is all', 5));
  });

  await t.test('cacheKey distinguishes source and limit', () => {
    assert.notEqual(cacheKey('a', 'q', 5), cacheKey('b', 'q', 5));
    assert.notEqual(cacheKey('a', 'q', 5), cacheKey('a', 'q', 10));
  });
});
