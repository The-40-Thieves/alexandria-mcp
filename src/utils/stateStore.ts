// Task 4 (review 3.4): persistence for the guard state that used to live only
// in process memory: the per-source daily quota ledger (quotaLedger.ts) and
// the search result cache (resultCache.ts). Both are keyed data with a
// tiny, generic shape (quota: a per-source-per-day counter; cache: a
// string key -> JSON value with an absolute expiry), so one interface
// backs both, with two implementations:
//
//   MemoryStateStore - a pair of Maps, process lifetime only. What every
//                      test uses, and what a startup that can't write its
//                      db file falls back to.
//   SqliteStateStore - node:sqlite's DatabaseSync at ALEXANDRIA_STATE_DB
//                      (default data/alexandria.db), WAL mode. Survives a
//                      process restart, which is the point: quota
//                      reservations and cache entries used to reset to
//                      zero on every deploy.
//
// node:sqlite is still marked experimental in the Node 24 docs (a
// `--no-experimental-sqlite` flag exists to turn it off), but importing it
// and using DatabaseSync prints no ExperimentalWarning on this Node
// version (checked live: `node -e "require('node:sqlite')"` with stderr
// captured separately is empty), so no suppression is needed to keep test
// output pristine.
//
// Selection happens once, at module load, in createStateStore() below -
// "in one place at startup" per the brief. That is the same timing
// quotaLedger.ts's old module-scope `const ledger = createLedger()` and
// resultCache.ts's old module-scope `export const searchCache = new
// ResultCache(...)` already used, so this is not a new eager-init
// pattern for this pair of modules. The test suite pins the selection to
// MemoryStateStore by setting ALEXANDRIA_STATE_DB=:memory: in the `test`
// npm script (package.json) rather than in every test file, so importing
// registry.ts (which every source adapter test does, transitively) never
// touches data/alexandria.db.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface StateStore {
  /** Current reserved count for `source` on `day` (0 if never reserved). */
  getQuota(source: string, day: string): number;
  // Atomically increments the source's count for `day` and reports whether
  // the *new* count is still within `cap`. The increment always happens,
  // matching quotaLedger.ts's existing reserveQuota(): a rejected
  // reservation still consumes its slot (see that file's module comment).
  reserveQuota(source: string, day: string, cap: number): boolean;
  /** The cached value for `key`, or undefined if absent or expired. */
  getCache<T = unknown>(key: string, now?: number): T | undefined;
  /** Stores `value` under `key`, replacing any prior TTL cap enforcement. */
  setCache<T = unknown>(key: string, value: T, expiresAt: number): void;
  /** Removes every cache entry whose expiresAt is at or before `now`. Returns the count removed. */
  evictExpired(now?: number): number;
  /** Raw row/entry count in the cache (used by /health; may include entries not yet lazily evicted). */
  cacheSize(): number;
  close(): void;
}

const DEFAULT_CACHE_MAX = 500;

// ─── MemoryStateStore ────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class MemoryStateStore implements StateStore {
  private quota = new Map<string, number>();
  private cache = new Map<string, CacheEntry>();
  private cacheMax: number;

  constructor(cacheMax = DEFAULT_CACHE_MAX) {
    this.cacheMax = cacheMax;
  }

  getQuota(source: string, day: string): number {
    return this.quota.get(`${source}:${day}`) ?? 0;
  }

  reserveQuota(source: string, day: string, cap: number): boolean {
    const key = `${source}:${day}`;
    const next = (this.quota.get(key) ?? 0) + 1;
    this.quota.set(key, next);
    return next <= cap;
  }

  getCache<T>(key: string, now = Date.now()): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  setCache<T>(key: string, value: T, expiresAt: number): void {
    // Map preserves insertion order and re-setting an existing key does
    // not move it, so only a genuinely new key at capacity evicts (the
    // oldest, by iteration order) - matching resultCache.ts's prior
    // behavior exactly.
    if (!this.cache.has(key) && this.cache.size >= this.cacheMax) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt });
  }

  evictExpired(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  cacheSize(): number {
    return this.cache.size;
  }

  close(): void {
    // Nothing to release.
  }
}

// ─── SqliteStateStore ────────────────────────────────────────────────────

export class SqliteStateStore implements StateStore {
  private db: DatabaseSync;
  private cacheMax: number;

  constructor(dbPath: string, cacheMax = DEFAULT_CACHE_MAX) {
    this.cacheMax = cacheMax;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quota (
        source TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, day)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expiresAt INTEGER NOT NULL
      )
    `);
  }

  getQuota(source: string, day: string): number {
    const row = this.db
      .prepare('SELECT count FROM quota WHERE source = ? AND day = ?')
      .get(source, day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  reserveQuota(source: string, day: string, cap: number): boolean {
    // INSERT ... ON CONFLICT DO UPDATE ... RETURNING is one statement, so
    // it is atomic with respect to any other synchronous call on this same
    // DatabaseSync connection - and DatabaseSync is synchronous end to
    // end, so there is no await between the read and the write for a
    // concurrent JS caller to interleave with (same reasoning
    // quotaLedger.ts's module comment gives for MemoryLedgerStore).
    const row = this.db
      .prepare(
        `INSERT INTO quota (source, day, count) VALUES (?, ?, 1)
         ON CONFLICT(source, day) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .get(source, day) as { count: number };
    return row.count <= cap;
  }

  getCache<T>(key: string, now = Date.now()): T | undefined {
    const row = this.db.prepare('SELECT value, expiresAt FROM cache WHERE key = ?').get(key) as
      | { value: string; expiresAt: number }
      | undefined;
    if (!row) return undefined;
    if (row.expiresAt <= now) {
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return undefined;
    }
    return JSON.parse(row.value) as T;
  }

  setCache<T>(key: string, value: T, expiresAt: number): void {
    const exists = this.db.prepare('SELECT 1 FROM cache WHERE key = ?').get(key);
    if (!exists) {
      const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM cache').get() as {
        count: number;
      };
      if (count >= this.cacheMax) {
        // Oldest by rowid: an UPDATE (the ON CONFLICT path below) never
        // changes a row's rowid, only a fresh INSERT does, so rowid order
        // tracks insertion order the same way resultCache.ts's Map did.
        this.db.exec(
          'DELETE FROM cache WHERE rowid = (SELECT rowid FROM cache ORDER BY rowid ASC LIMIT 1)',
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO cache (key, value, expiresAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt`,
      )
      .run(key, JSON.stringify(value), expiresAt);
  }

  evictExpired(now = Date.now()): number {
    const result = this.db.prepare('DELETE FROM cache WHERE expiresAt <= ?').run(now);
    return Number(result.changes);
  }

  cacheSize(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM cache').get() as {
      count: number;
    };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}

// ─── selection ───────────────────────────────────────────────────────────

const DEFAULT_STATE_DB_PATH = path.resolve(import.meta.dirname, '../../data/alexandria.db');

let warnedFallback = false;

function warnFallbackOnce(reason: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.error(`[alexandria] state store: falling back to an in-memory store (${reason})`);
}

/** Test-only: clears the "already warned" latch so a test can observe the warning fire again. */
export function resetStateStoreWarningForTests(): void {
  warnedFallback = false;
}

// default: sqlite at ALEXANDRIA_STATE_DB (or data/alexandria.db); memory
// when that var is literally ':memory:', or when the sqlite file can't be
// created (permissions, read-only filesystem, etc - logged once).
export function createStateStore(env: NodeJS.ProcessEnv = process.env): StateStore {
  const raw = env.ALEXANDRIA_STATE_DB;
  if (raw === ':memory:') return new MemoryStateStore();
  const dbPath = raw ?? DEFAULT_STATE_DB_PATH;
  try {
    return new SqliteStateStore(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnFallbackOnce(`${dbPath}: ${message}`);
    return new MemoryStateStore();
  }
}

export const stateStore: StateStore = createStateStore();
