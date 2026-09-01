import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryLedgerStore, QuotaExceededError, reserveQuota, utcDay } from './quotaLedger.js';

test('quotaLedger', async (t) => {
  await t.test('utcDay formats as YYYY-MM-DD', () => {
    assert.equal(utcDay(new Date('2026-09-01T23:59:59.000Z')), '2026-09-01');
  });

  await t.test('reservations up to the cap pass through without throwing', async () => {
    const store = new MemoryLedgerStore();
    await assert.doesNotReject(reserveQuota('src', 2, store));
    await assert.doesNotReject(reserveQuota('src', 2, store));
  });

  await t.test('a reservation beyond the cap throws QuotaExceededError', async () => {
    const store = new MemoryLedgerStore();
    await reserveQuota('src', 2, store);
    await reserveQuota('src', 2, store);
    await assert.rejects(reserveQuota('src', 2, store), QuotaExceededError);
  });

  await t.test('uncapped source never throws regardless of usage', async () => {
    const store = new MemoryLedgerStore();
    for (let i = 0; i < 50; i++) {
      await assert.doesNotReject(reserveQuota('src', undefined, store));
    }
  });

  await t.test('a failed adapter call still consumes its reserved slot', async () => {
    const store = new MemoryLedgerStore();
    try {
      await reserveQuota('src', 5, store); // slot is spent by this reservation, up front
      throw new Error('simulated adapter failure');
    } catch {
      // simulates search() throwing after reserveQuota passed; nothing rolls the count back
    }
    assert.equal(await store.get('src', utcDay()), 1);
  });

  await t.test('usage is scoped per day', async () => {
    const store = new MemoryLedgerStore();
    assert.equal(await store.increment('src', '2026-09-01'), 1);
    assert.equal(await store.get('src', '2026-09-01'), 1);
    assert.equal(await store.get('src', '2026-09-02'), 0);
  });

  await t.test(
    '6 concurrent reservations against a cap of 3 yield exactly 3 successes and 3 QuotaExceededError rejections',
    async () => {
      // This proves MemoryLedgerStore#increment does not await before
      // mutating its Map: reserveQuota() calls it, then awaits, so all 6
      // calls below start synchronously in the order Promise.all invokes
      // them, and each sees the count already updated by every prior call
      // (JS run-to-completion: increment's synchronous body, read, add
      // one, write, runs to the end before the caller's `await` yields).
      // A version of increment with an await before the Map write would
      // let all 6 calls read the same stale count before any of them
      // wrote, producing far fewer than 3 rejections and breaking this
      // assertion.
      const store = new MemoryLedgerStore();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => reserveQuota('src', 3, store)),
      );
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      assert.equal(fulfilled.length, 3);
      assert.equal(rejected.length, 3);
      for (const outcome of rejected) {
        assert.ok((outcome as PromiseRejectedResult).reason instanceof QuotaExceededError);
      }
    },
  );
});
