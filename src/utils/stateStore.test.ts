import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStateStore,
  MemoryStateStore,
  resetStateStoreWarningForTests,
  SqliteStateStore,
  type StateStore,
} from './stateStore.ts';

function tmpDbPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-state-')), name);
}

// Same behavioral contract, run against both implementations.
function sharedContract(label: string, makeStore: () => StateStore) {
  test(`StateStore contract: ${label}`, async (t) => {
    await t.test('getQuota is 0 for a source never reserved', () => {
      const store = makeStore();
      assert.equal(store.getQuota('src', '2026-09-01'), 0);
      store.close();
    });

    await t.test('reservations up to the cap return true', () => {
      const store = makeStore();
      assert.equal(store.reserveQuota('src', '2026-09-01', 2), true);
      assert.equal(store.reserveQuota('src', '2026-09-01', 2), true);
      assert.equal(store.getQuota('src', '2026-09-01'), 2);
      store.close();
    });

    await t.test('a reservation beyond the cap returns false but still increments', () => {
      const store = makeStore();
      store.reserveQuota('src', '2026-09-01', 2);
      store.reserveQuota('src', '2026-09-01', 2);
      assert.equal(store.reserveQuota('src', '2026-09-01', 2), false);
      assert.equal(store.getQuota('src', '2026-09-01'), 3);
      store.close();
    });

    await t.test('quota is scoped per source and per day', () => {
      const store = makeStore();
      store.reserveQuota('a', '2026-09-01', 10);
      assert.equal(store.getQuota('a', '2026-09-01'), 1);
      assert.equal(store.getQuota('b', '2026-09-01'), 0);
      assert.equal(store.getQuota('a', '2026-09-02'), 0);
      store.close();
    });

    await t.test('cache returns undefined on miss', () => {
      const store = makeStore();
      assert.equal(store.getCache('missing'), undefined);
      store.close();
    });

    await t.test('cache returns the stored value before expiry', () => {
      const store = makeStore();
      store.setCache('k', { hello: 'world' }, 1000);
      assert.deepEqual(store.getCache('k', 500), { hello: 'world' });
      store.close();
    });

    await t.test('cache expires entries at or after expiresAt', () => {
      const store = makeStore();
      store.setCache('k', 42, 1000);
      assert.equal(store.getCache('k', 1000), undefined);
      store.close();
    });

    await t.test('setCache on an existing key updates the value without evicting others', () => {
      const store = makeStore();
      store.setCache('k', 1, 1000);
      store.setCache('k', 2, 2000);
      assert.equal(store.getCache('k', 0), 2);
      store.close();
    });

    await t.test('evictExpired removes only expired entries and reports the count', () => {
      const store = makeStore();
      store.setCache('a', 1, 100);
      store.setCache('b', 2, 10_000);
      const removed = store.evictExpired(1000);
      assert.equal(removed, 1);
      assert.equal(store.cacheSize(), 1);
      assert.equal(store.getCache('b', 1000), 2);
      store.close();
    });
  });
}

sharedContract('MemoryStateStore', () => new MemoryStateStore());
sharedContract('SqliteStateStore', () => new SqliteStateStore(tmpDbPath('contract.db')));

test('MemoryStateStore cache cap', async (t) => {
  await t.test('evicts the oldest entry once the cap is exceeded', () => {
    const store = new MemoryStateStore(2);
    store.setCache('a', 1, 1000);
    store.setCache('b', 2, 1000);
    store.setCache('c', 3, 1000);
    assert.equal(store.getCache('a', 0), undefined);
    assert.equal(store.getCache('b', 0), 2);
    assert.equal(store.getCache('c', 0), 3);
    assert.equal(store.cacheSize(), 2);
  });
});

test('SqliteStateStore', async (t) => {
  await t.test('the 500-entry cap is enforced by count on insert', () => {
    const store = new SqliteStateStore(tmpDbPath('cap.db'), 2);
    store.setCache('a', 1, 1000);
    store.setCache('b', 2, 1000);
    store.setCache('c', 3, 1000);
    assert.equal(store.getCache('a', 0), undefined);
    assert.equal(store.getCache('b', 0), 2);
    assert.equal(store.getCache('c', 0), 3);
    assert.equal(store.cacheSize(), 2);
    store.close();
  });

  await t.test(
    '6 concurrent-shaped reservations against a cap of 3 yield exactly 3 successes',
    () => {
      const store = new SqliteStateStore(tmpDbPath('concurrent.db'));
      const results = Array.from({ length: 6 }, () => store.reserveQuota('src', '2026-09-01', 3));
      assert.equal(results.filter(Boolean).length, 3);
      assert.equal(store.getQuota('src', '2026-09-01'), 6);
      store.close();
    },
  );

  await t.test('close then reopen the same file: the reserved count survives', () => {
    const dbPath = tmpDbPath('restart.db');
    const first = new SqliteStateStore(dbPath);
    first.reserveQuota('arxiv', '2026-09-01', 100);
    first.reserveQuota('arxiv', '2026-09-01', 100);
    assert.equal(first.getQuota('arxiv', '2026-09-01'), 2);
    first.close();

    const second = new SqliteStateStore(dbPath);
    assert.equal(second.getQuota('arxiv', '2026-09-01'), 2);
    second.close();
  });

  await t.test('creates the parent directory if it does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-state-'));
    const dbPath = path.join(dir, 'nested', 'deeper', 'alexandria.db');
    const store = new SqliteStateStore(dbPath);
    assert.ok(fs.existsSync(dbPath));
    store.close();
  });

  await t.test('runs in WAL mode', () => {
    const dbPath = tmpDbPath('wal.db');
    const store = new SqliteStateStore(dbPath);
    // A plain rollback-journal database never creates a `-wal` sidecar
    // file; WAL mode creates one as soon as a write happens, and drops it
    // again on a clean close (checked live, see the report).
    store.reserveQuota('src', '2026-09-01', 10);
    assert.ok(fs.existsSync(`${dbPath}-wal`));
    store.close();
    assert.ok(!fs.existsSync(`${dbPath}-wal`));
  });
});

test('createStateStore selection', async (t) => {
  await t.test('ALEXANDRIA_STATE_DB=:memory: selects MemoryStateStore', () => {
    const store = createStateStore({ ALEXANDRIA_STATE_DB: ':memory:' } as NodeJS.ProcessEnv);
    assert.ok(store instanceof MemoryStateStore);
    store.close();
  });

  await t.test('an explicit writable path selects SqliteStateStore', () => {
    const dbPath = tmpDbPath('selected.db');
    const store = createStateStore({ ALEXANDRIA_STATE_DB: dbPath } as NodeJS.ProcessEnv);
    assert.ok(store instanceof SqliteStateStore);
    store.close();
  });

  await t.test('an unwritable path falls back to MemoryStateStore and warns once', () => {
    resetStateStoreWarningForTests();
    // A path under a file (not a directory) can never be mkdir'd into.
    const blocker = tmpDbPath('blocker-file');
    fs.writeFileSync(blocker, '');
    const unwritable = path.join(blocker, 'nested', 'alexandria.db');
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (msg: string) => warnings.push(msg);
    try {
      const store = createStateStore({ ALEXANDRIA_STATE_DB: unwritable } as NodeJS.ProcessEnv);
      assert.ok(store instanceof MemoryStateStore);
      store.close();
      assert.equal(warnings.length, 1);
    } finally {
      console.error = originalError;
    }
  });
});
