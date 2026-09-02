// THE-166: a short TTL cache for search results, keyed by source+query+limit.
// Task 4: backed by a StateStore rather than its own Map, so the
// default (sqlite) deployment survives a restart. A store-less caller still
// gets the exact prior behavior via a private MemoryStateStore.

import { config } from '../config.ts';
import type { LibraryResult } from '../types.ts';
import {
  stateStore as defaultStateStore,
  MemoryStateStore,
  type StateStore,
} from './stateStore.ts';

export class ResultCache<T> {
  private store: StateStore;
  // A plain number for direct callers/tests (unchanged); a thunk for
  // searchCache below, so resolving it - and with it, the one
  // config.ALEXANDRIA_CACHE_TTL_MS read behind parseTtlMs() - is deferred
  // to the first actual set() call instead of running at module load. See
  // config.ts's module comment: a single config field access runs the full
  // schema.safeParse(process.env), and resultCache.ts is imported by
  // registry.ts, which is imported by nearly everything.
  private ttlMs: number | (() => number);

  constructor(ttlMs: number | (() => number), store: StateStore = new MemoryStateStore()) {
    this.ttlMs = ttlMs;
    this.store = store;
  }

  private resolveTtlMs(): number {
    return typeof this.ttlMs === 'function' ? this.ttlMs() : this.ttlMs;
  }

  get(key: string, now = Date.now()): T | undefined {
    return this.store.getCache<T>(key, now);
  }

  set(key: string, value: T, now = Date.now()): void {
    const ttlMs = this.resolveTtlMs();
    if (ttlMs <= 0) return; // 0 disables caching
    this.store.setCache(key, value, now + ttlMs);
  }
}

const DEFAULT_CACHE_TTL_MS = 600_000;

// Number() on a non-numeric or missing value yields NaN, which passes the
// `<= 0` disable check in ResultCache#set and makes entries never expire
// (NaN <= 0 is false, and now + NaN is NaN, so entry.expiresAt <= now is
// also always false). Fall back to the default for anything that isn't a
// finite, non-negative number.
export function parseTtlMs(raw: string | undefined, fallback = DEFAULT_CACHE_TTL_MS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// A thunk, not a resolved number: see ResultCache's ttlMs comment above.
export const searchCache = new ResultCache<LibraryResult[]>(
  () => parseTtlMs(config.ALEXANDRIA_CACHE_TTL_MS),
  defaultStateStore,
);

export function cacheKey(source: string, query: string, limit: number): string {
  return `${source}|${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${limit}`;
}
