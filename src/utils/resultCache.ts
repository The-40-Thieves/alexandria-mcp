// THE-166: a short TTL cache for search results, keyed by source+query+limit.

import type { LibraryResult } from '../types.ts';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class ResultCache<T> {
  private store = new Map<string, Entry<T>>();
  private ttlMs: number;
  private max: number;

  constructor(ttlMs: number, max = 500) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.ttlMs <= 0) return; // 0 disables caching
    if (!this.store.has(key) && this.store.size >= this.max) {
      // Map preserves insertion order; the first key is the oldest.
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
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
export const searchCache = new ResultCache<LibraryResult[]>(CACHE_TTL_MS);

export function cacheKey(source: string, query: string, limit: number): string {
  return `${source}|${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${limit}`;
}
