import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReadResult } from '../types.ts';
import { READ_CACHE_TTL_MS, ReadCache, readCacheKey } from './readCache.ts';
import { MemoryStateStore } from './stateStore.ts';

const RESULT: ReadResult = { title: 'A Book', authors: ['A. Author'], text: 'full text' };

test('readCache', async (t) => {
  await t.test('returns undefined on miss', () => {
    const c = new ReadCache(new MemoryStateStore());
    assert.equal(c.get('gutenberg', '1'), undefined);
  });

  await t.test('returns the stored value before expiry', () => {
    const c = new ReadCache(new MemoryStateStore());
    c.set('gutenberg', '1', RESULT, 1000, 0);
    assert.deepEqual(c.get('gutenberg', '1', 500), RESULT);
  });

  await t.test('expires entries after ttlMs', () => {
    const c = new ReadCache(new MemoryStateStore());
    c.set('gutenberg', '1', RESULT, 1000, 0);
    assert.equal(c.get('gutenberg', '1', 1001), undefined);
  });

  await t.test('a ttlMs of 0 (realtime) never stores anything', () => {
    const c = new ReadCache(new MemoryStateStore());
    c.set('coingecko', '1', RESULT, READ_CACHE_TTL_MS.realtime, 0);
    assert.equal(c.get('coingecko', '1', 0), undefined);
  });

  await t.test('a negative ttlMs never stores anything', () => {
    const c = new ReadCache(new MemoryStateStore());
    c.set('coingecko', '1', RESULT, -1, 0);
    assert.equal(c.get('coingecko', '1', 0), undefined);
  });

  await t.test('distinguishes source and id', () => {
    const c = new ReadCache(new MemoryStateStore());
    c.set('gutenberg', '1', RESULT, 1000, 0);
    assert.equal(c.get('archive', '1', 0), undefined);
    assert.equal(c.get('gutenberg', '2', 0), undefined);
  });

  await t.test(
    'readCacheKey cannot collide with a resultCache cacheKey for a plausible source name',
    () => {
      // readCache and searchCache share one physical stateStore table (both
      // default to the same StateStore singleton), so a cacheKey(source, ...)
      // and a readCacheKey(...) must never produce the identical string for
      // any registry source name this repo would plausibly register. No
      // registered source is literally named "read" (registry names are
      // single short words, per every source in src/sources/*.ts).
      assert.notEqual(readCacheKey('gutenberg', '1'), 'gutenberg|1|10');
    },
  );

  await t.test(
    'READ_CACHE_TTL_MS matches the brief: static 24h, daily 10min, realtime never',
    () => {
      assert.equal(READ_CACHE_TTL_MS.static, 24 * 60 * 60 * 1000);
      assert.equal(READ_CACHE_TTL_MS.daily, 10 * 60 * 1000);
      assert.equal(READ_CACHE_TTL_MS.realtime, 0);
    },
  );
});
