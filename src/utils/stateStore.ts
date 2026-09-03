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
// Selection happens once, at the *first store method call*, in
// createStateStore() below via the LazyStateStore wrapper further down -
// "in one place at startup" per the brief, but deferred rather than run at
// module load. It was eager at module load in the first version of this
// file; review caught that merely IMPORTING stateStore.ts (which
// registry.ts, quotaLedger.ts, and resultCache.ts all do at their own
// module scope) constructed a SqliteStateStore and so created
// data/alexandria.db as a side effect of import alone - hit by
// `npm run docs` (gen-docs.ts imports registry.ts), `npm run probe`,
// `npm run eval:routing`, and any test file run directly with
// `node --test <file>` instead of through the `npm test` script that sets
// ALEXANDRIA_STATE_DB=:memory:. The exported `stateStore` singleton below
// is now a thin proxy: no disk access, no DatabaseSync, until something
// actually calls one of its methods.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { SECURE_DIR_MODE, secureSqliteFile } from './fileMode.ts';

export interface StateStore {
  /** Current reserved count for `source` on `day` (0 if never reserved). */
  getQuota(source: string, day: string): number;
  // Atomically increments the source's count for `day` and returns the new
  // count, or null once that count exceeds `cap`. The increment always
  // happens either way, matching quotaLedger.ts's existing reserveQuota():
  // a rejected reservation still consumes its slot (see that file's module
  // comment).
  reserveQuota(source: string, day: string, cap: number): number | null;
  // Every source with a nonzero reservation on `day`, in one read - used by
  // /health so it does not do one getQuota() round trip per registered
  // source (there are 138+).
  quotaForDay(day: string): Map<string, number>;
  /** The cached value for `key`, or undefined if absent or expired. */
  getCache<T = unknown>(key: string, now?: number): T | undefined;
  /** Stores `value` under `key`, replacing any prior TTL cap enforcement. */
  setCache<T = unknown>(key: string, value: T, expiresAt: number, now?: number): void;
  /** Removes every cache entry whose expiresAt is at or before `now`. Returns the count removed. */
  evictExpired(now?: number): number;
  /** Raw row/entry count in the cache (used by /health; may include entries not yet lazily evicted). */
  cacheSize(): number;
  close(): void;
}

const DEFAULT_CACHE_MAX = 500;

// resultCache.ts's routingCache prefixes every key with this (see that
// module's comment on routingCacheKey for why "routing-decision|" in
// particular can never collide with a cacheKey(source, ...) entry). Final
// wave, A8: the cache table's cacheMax cap used to be shared by both
// callers of one StateStore (searchCache and routingCache), so a burst of
// routing decisions could evict search results and vice versa. Both
// setCache() implementations below cap the routing-decision namespace and
// everything else independently at cacheMax each, using this prefix as
// the split point - defined here (not resultCache.ts, which imports FROM
// this module) so both sides share one source of truth instead of two
// copies of the literal string drifting apart.
export const ROUTING_CACHE_KEY_PREFIX = 'routing-decision|';

function isRoutingCacheKey(key: string): boolean {
  return key.startsWith(ROUTING_CACHE_KEY_PREFIX);
}

// Final wave, A9: quota rows/keys are one-per-source-per-UTC-day and were
// never pruned, so they accumulate forever. `day` is always the
// 'YYYY-MM-DD' shape quotaLedger.ts's callers already use, which sorts
// (and subtracts) correctly as a plain string/Date - no calendar library
// needed. Called once per genuinely new `day` seen by reserveQuota() in
// both implementations, not on every call, since it needs to scan/delete.
const QUOTA_RETENTION_DAYS = 7;

function cutoffDay(day: string, retentionDays: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - retentionDays);
  return d.toISOString().slice(0, 10);
}

// ─── MemoryStateStore ────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class MemoryStateStore implements StateStore {
  // day -> source -> count, so quotaForDay() is a plain Map lookup instead
  // of a scan-and-parse over composite `${source}:${day}` keys.
  private quota = new Map<string, Map<string, number>>();
  private cache = new Map<string, CacheEntry>();
  private cacheMax: number;
  private lastPrunedQuotaDay: string | undefined;

  constructor(cacheMax = DEFAULT_CACHE_MAX) {
    this.cacheMax = cacheMax;
  }

  getQuota(source: string, day: string): number {
    return this.quota.get(day)?.get(source) ?? 0;
  }

  reserveQuota(source: string, day: string, cap: number): number | null {
    if (day !== this.lastPrunedQuotaDay) {
      const cutoff = cutoffDay(day, QUOTA_RETENTION_DAYS);
      for (const d of this.quota.keys()) {
        if (d < cutoff) this.quota.delete(d);
      }
      this.lastPrunedQuotaDay = day;
    }
    let sources = this.quota.get(day);
    if (!sources) {
      sources = new Map();
      this.quota.set(day, sources);
    }
    const next = (sources.get(source) ?? 0) + 1;
    sources.set(source, next);
    return next <= cap ? next : null;
  }

  quotaForDay(day: string): Map<string, number> {
    return new Map(this.quota.get(day) ?? []);
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

  setCache<T>(key: string, value: T, expiresAt: number, now = Date.now()): void {
    // Expired-but-not-yet-evicted rows must not count against the cap -
    // otherwise a burst of short-TTL entries that have already logically
    // expired can still crowd out a fresh one (final wave, A8/A9). `now`
    // defaults to Date.now() but is threaded through explicitly (rather
    // than each call reading the real clock independently) so a caller
    // with its own notion of "now" - ResultCache#set already computes one
    // - and a test with a synthetic clock both see one consistent value.
    this.evictExpired(now);
    // Map preserves insertion order and re-setting an existing key does
    // not move it, so only a genuinely new key at capacity evicts (the
    // oldest, by iteration order) - matching resultCache.ts's prior
    // behavior exactly. The routing-decision namespace and everything else
    // are capped independently (final wave, A8) so one can never evict the
    // other.
    if (!this.cache.has(key) && this.namespaceSize(key) >= this.cacheMax) {
      const routing = isRoutingCacheKey(key);
      for (const oldestKey of this.cache.keys()) {
        if (isRoutingCacheKey(oldestKey) === routing) {
          this.cache.delete(oldestKey);
          break;
        }
      }
    }
    this.cache.set(key, { value, expiresAt });
  }

  private namespaceSize(key: string): number {
    const routing = isRoutingCacheKey(key);
    let count = 0;
    for (const k of this.cache.keys()) {
      if (isRoutingCacheKey(k) === routing) count++;
    }
    return count;
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
  // Final wave, A7: warn at most once per corrupt/truncated key, not once
  // per read - a hot key with a bad row would otherwise log on every
  // guarded search()/planRoute() call that misses.
  private warnedCorruptKeys = new Set<string>();
  private lastPrunedQuotaDay: string | undefined;

  constructor(dbPath: string, cacheMax = DEFAULT_CACHE_MAX) {
    this.cacheMax = cacheMax;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: SECURE_DIR_MODE });
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
    // alexandria.db holds the quota ledger and cached search/routing
    // decisions; DatabaseSync creates the file (and, once the CREATE
    // TABLE statements above have written under WAL mode, its -wal/-shm
    // siblings) with the process umask, so tighten all of them to
    // owner-only here, after they exist (final wave, A5).
    secureSqliteFile(dbPath);
  }

  getQuota(source: string, day: string): number {
    const row = this.db
      .prepare('SELECT count FROM quota WHERE source = ? AND day = ?')
      .get(source, day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  reserveQuota(source: string, day: string, cap: number): number | null {
    // Final wave, A9: one row per source per UTC day accumulates forever
    // otherwise. Only runs the DELETE on the first reservation of a
    // genuinely new day, not on every call.
    if (day !== this.lastPrunedQuotaDay) {
      this.db.prepare('DELETE FROM quota WHERE day < ?').run(cutoffDay(day, QUOTA_RETENTION_DAYS));
      this.lastPrunedQuotaDay = day;
    }
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
    return row.count <= cap ? row.count : null;
  }

  quotaForDay(day: string): Map<string, number> {
    const rows = this.db.prepare('SELECT source, count FROM quota WHERE day = ?').all(day) as {
      source: string;
      count: number;
    }[];
    return new Map(rows.map((r) => [r.source, r.count]));
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
    // A corrupt or truncated value (a partial write, a disk-level bit flip,
    // a manual edit) must miss like any other cache miss, not throw into
    // the guarded search() or planRoute() paths above this store. Delete
    // the bad row so it doesn't keep failing on every subsequent read.
    try {
      return JSON.parse(row.value) as T;
    } catch (err) {
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      if (!this.warnedCorruptKeys.has(key)) {
        this.warnedCorruptKeys.add(key);
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ key, message }, 'state store: corrupt cache row, treating as a miss');
      }
      return undefined;
    }
  }

  setCache<T>(key: string, value: T, expiresAt: number, now = Date.now()): void {
    // Expired-but-not-yet-evicted rows must not count against the cap
    // (final wave, A8/A9). See MemoryStateStore's setCache for why `now`
    // is threaded through rather than read from the clock a second time.
    this.evictExpired(now);
    const exists = this.db.prepare('SELECT 1 FROM cache WHERE key = ?').get(key);
    if (!exists) {
      // The routing-decision namespace and everything else are capped
      // independently (final wave, A8) so a burst of routing decisions can
      // never evict search results, or vice versa: a LIKE-scoped count and
      // a LIKE-scoped oldest-row delete, rather than the whole table.
      const routing = isRoutingCacheKey(key);
      const likePattern = routing ? `${ROUTING_CACHE_KEY_PREFIX}%` : null;
      const { count } = (
        likePattern
          ? this.db.prepare('SELECT COUNT(*) AS count FROM cache WHERE key LIKE ?').get(likePattern)
          : this.db
              .prepare('SELECT COUNT(*) AS count FROM cache WHERE key NOT LIKE ?')
              .get(`${ROUTING_CACHE_KEY_PREFIX}%`)
      ) as { count: number };
      if (count >= this.cacheMax) {
        // Oldest by rowid: an UPDATE (the ON CONFLICT path below) never
        // changes a row's rowid, only a fresh INSERT does, so rowid order
        // tracks insertion order the same way resultCache.ts's Map did.
        if (likePattern) {
          this.db
            .prepare(
              'DELETE FROM cache WHERE rowid = (SELECT rowid FROM cache WHERE key LIKE ? ORDER BY rowid ASC LIMIT 1)',
            )
            .run(likePattern);
        } else {
          this.db
            .prepare(
              'DELETE FROM cache WHERE rowid = (SELECT rowid FROM cache WHERE key NOT LIKE ? ORDER BY rowid ASC LIMIT 1)',
            )
            .run(`${ROUTING_CACHE_KEY_PREFIX}%`);
        }
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
  log.warn({ reason }, 'state store: falling back to an in-memory store');
}

/** Test-only: clears the "already warned" latch so a test can observe the warning fire again. */
export function resetStateStoreWarningForTests(): void {
  warnedFallback = false;
}

// default: sqlite at ALEXANDRIA_STATE_DB (or data/alexandria.db); memory
// when that var is literally ':memory:', or when the sqlite file can't be
// created (permissions, read-only filesystem, etc - logged once).
// `env` takes just the one field it needs (not the whole Config) so a test
// can keep passing a bare `{ ALEXANDRIA_STATE_DB: ... }` object, exactly as
// it did against process.env before.
export function createStateStore(env: Pick<Config, 'ALEXANDRIA_STATE_DB'> = config): StateStore {
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

// Defers createStateStore() to the first method call instead of running it
// at module load, so importing stateStore.ts (or anything that imports it
// transitively - registry.ts, quotaLedger.ts, resultCache.ts, gen-docs.ts,
// probe.ts, eval-routing.ts) never touches disk on its own. Every method
// below just forwards to a lazily-built underlying store.
class LazyStateStore implements StateStore {
  private instance: StateStore | undefined;

  private target(): StateStore {
    if (!this.instance) this.instance = createStateStore();
    return this.instance;
  }

  getQuota(source: string, day: string): number {
    return this.target().getQuota(source, day);
  }

  reserveQuota(source: string, day: string, cap: number): number | null {
    return this.target().reserveQuota(source, day, cap);
  }

  quotaForDay(day: string): Map<string, number> {
    return this.target().quotaForDay(day);
  }

  getCache<T = unknown>(key: string, now?: number): T | undefined {
    return this.target().getCache<T>(key, now);
  }

  setCache<T = unknown>(key: string, value: T, expiresAt: number, now?: number): void {
    this.target().setCache(key, value, expiresAt, now);
  }

  evictExpired(now?: number): number {
    return this.target().evictExpired(now);
  }

  cacheSize(): number {
    return this.target().cacheSize();
  }

  close(): void {
    // Only close what was actually opened - calling close() without ever
    // calling another method must not itself construct (and then
    // immediately close) a store.
    if (this.instance) {
      this.instance.close();
      this.instance = undefined;
    }
  }
}

export const stateStore: StateStore = new LazyStateStore();

// Final wave, A11: a named entry point for index.ts's shutdown hook,
// alongside dispatcher.ts's closeDispatchers() - closes the sqlite
// connection (if one was ever opened; LazyStateStore#close() only closes
// what it actually built) so a clean SIGTERM/SIGINT doesn't leave a
// dangling file handle.
export function closeStateStore(): void {
  stateStore.close();
}
