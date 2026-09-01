import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QuotaExceededError,
  MemoryLedgerStore,
  utcDay,
  enforceQuota,
  recordUsage,
} from './quotaLedger.js';

test('quotaLedger', async (t) => {
  await t.test('utcDay formats as YYYY-MM-DD', () => {
    assert.equal(utcDay(new Date('2026-09-01T23:59:59.000Z')), '2026-09-01');
  });

  await t.test('under cap passes through without throwing', async () => {
    const store = new MemoryLedgerStore();
    await recordUsage('src', store);
    await assert.doesNotReject(enforceQuota('src', 5, store));
  });

  await t.test('at cap throws QuotaExceededError', async () => {
    const store = new MemoryLedgerStore();
    await recordUsage('src', store);
    await recordUsage('src', store);
    await assert.rejects(enforceQuota('src', 2, store), QuotaExceededError);
  });

  await t.test('uncapped source never throws regardless of usage', async () => {
    const store = new MemoryLedgerStore();
    for (let i = 0; i < 50; i++) await recordUsage('src', store);
    await assert.doesNotReject(enforceQuota('src', undefined, store));
  });

  await t.test('a failed call still records usage', async () => {
    const store = new MemoryLedgerStore();
    try {
      await enforceQuota('src', 5, store); // capacity is available
      throw new Error('simulated adapter failure');
    } catch {
      // simulates search() throwing after enforceQuota passed
    } finally {
      await recordUsage('src', store);
    }
    assert.equal(await store.get('src', utcDay()), 1);
  });

  await t.test('usage is scoped per day', async () => {
    const store = new MemoryLedgerStore();
    assert.equal(await store.increment('src', '2026-09-01'), 1);
    assert.equal(await store.get('src', '2026-09-01'), 1);
    assert.equal(await store.get('src', '2026-09-02'), 0);
  });
});
