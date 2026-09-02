// THE-166: a short TTL cache for search results, keyed by source+query+limit.
// Task 4: backed by a StateStore rather than its own Map, so the
// default (sqlite) deployment survives a restart. A store-less caller still
// gets the exact prior behavior via a private MemoryStateStore.

import type { LibraryResult } from '../types.ts';
import {
  stateStore as defaultStateStore,
  MemoryStateStore,
  type StateStore,
} from './stateStore.ts';

export class ResultCache<T> {
  private store: StateStore;
  private ttlMs: number;

  constructor(ttlMs: number, store: StateStore = new MemoryStateStore()) {
    this.ttlMs = ttlMs;
    this.store = store;
  }

  get(key: string, now = Date.now()): T | undefined {
    return this.store.getCache<T>(key, now);
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.ttlMs <= 0) return; // 0 disables caching
    this.store.setCache(key, value, now + this.ttlMs);
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

const CACHE_TTL_MS = parseTtlMs(process.env.ALEXANDRIA_CACHE_TTL_MS);
export const searchCache = new ResultCache<LibraryResult[]>(CACHE_TTL_MS, defaultStateStore);

export function cacheKey(source: string, query: string, limit: number): string {
  return `${source}|${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${limit}`;
}
