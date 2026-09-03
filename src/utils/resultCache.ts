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

// Task 6: library_ask's routing decision (which sources stage 2 picked, or
// which ones stage 1's margin-skip fanned out to), keyed by normalised
// query + max_sources so a repeated query costs no LLM call at all - not
// even the query embed() stage 1 needs when embeddings are configured.
// Same physical store and TTL as searchCache above (per the interface this
// task builds on: "the result cache TTL is config.ALEXANDRIA_CACHE_TTL_MS")
// - the "routing-decision|" prefix in routingCacheKey is what keeps the two
// kinds of entry from colliding in that one shared cache table: cacheKey's
// first field is a registry source name (a short, code-defined identifier,
// never "routing-decision"), so this prefix can never coincide with one -
// unlike a shorter prefix such as "route", which a source named exactly
// "route" would collide with (cacheKey('route', q, n) and
// routingCacheKey(q, n) would then produce the identical string).
export interface CachedRoute {
  source: string;
  query: string;
  reason: string;
  cluster: string;
}

export interface CachedRoutingDecision {
  intent: string;
  stage2: 'llm' | 'skipped';
  routes: CachedRoute[];
}

export const routingCache = new ResultCache<CachedRoutingDecision>(
  () => parseTtlMs(config.ALEXANDRIA_CACHE_TTL_MS),
  defaultStateStore,
);

export function routingCacheKey(query: string, maxSources: number): string {
  return `routing-decision|${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${maxSources}`;
}

// Test-only: clears every entry in the shared stateStore cache table (both
// searchCache's and routingCache's - StateStore has no per-key delete, only
// evictExpired(now), so a `now` past every real expiry evicts everything;
// a concrete far-future epoch ms rather than Infinity, since node:sqlite
// can't bind a non-finite number). Needed because the underlying stateStore
// is a process-lifetime singleton: a test file with several sub-tests that
// route the exact same literal query text (a shared TOKEN constant, say)
// would otherwise see a later sub-test's routing decision silently
// replayed from an earlier one's cache entry instead of exercising its own
// router mock.
const FAR_FUTURE_MS = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;

export function resetRoutingCacheForTests(): void {
  defaultStateStore.evictExpired(FAR_FUTURE_MS);
}
