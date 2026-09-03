// Task 2 (vault idea 7): a per-process cache for library_read, keyed by
// source+id, backed by the same StateStore cache table search results and
// routing decisions already use (see resultCache.ts). Unlike ResultCache's
// ttlMs (one fixed value per instance, read from config), a read's TTL
// depends on the SOURCE's freshness (registry.ts's SourceMeta.freshness),
// which withGuards.read already knows per call - so ttlMs is a set()
// parameter here instead of a constructor field.
import type { ReadResult } from '../types.ts';
import { stateStore as defaultStateStore, type StateStore } from './stateStore.ts';

// A read is keyed on an exact item id, not a normalised free-text query
// (unlike resultCache.ts's cacheKey), so no whitespace/case folding
// applies here. "read|" can never collide with a cacheKey(source, query,
// limit) entry for the same reason resultCache.ts's ROUTING_CACHE_KEY_PREFIX
// can't: cacheKey's first field is a registry source name, which is never
// the literal string "read" (see registry.test.ts / resultCache.test.ts for
// the equivalent check on that prefix).
const READ_CACHE_KEY_PREFIX = 'read|';

export function readCacheKey(source: string, id: string): string {
  return `${READ_CACHE_KEY_PREFIX}${source}|${id}`;
}

export class ReadCache {
  private store: StateStore;

  constructor(store: StateStore = defaultStateStore) {
    this.store = store;
  }

  get(source: string, id: string, now = Date.now()): ReadResult | undefined {
    return this.store.getCache<ReadResult>(readCacheKey(source, id), now);
  }

  // ttlMs <= 0 (a realtime source; see READ_CACHE_TTL_MS below) never
  // stores anything, mirroring ResultCache#set's identical guard.
  set(source: string, id: string, result: ReadResult, ttlMs: number, now = Date.now()): void {
    if (ttlMs <= 0) return;
    this.store.setCache(readCacheKey(source, id), result, now + ttlMs, now);
  }
}

export const readCache = new ReadCache();

// TTL by SourceMeta.freshness (task-2 brief): static content changes
// rarely (24h); a daily-refreshed source gets a short window (10min),
// mostly to survive a burst of repeat reads within one agent turn; a
// realtime source (stock quotes, live feeds) is never cached.
export const READ_CACHE_TTL_MS: Record<'static' | 'daily' | 'realtime', number> = {
  static: 24 * 60 * 60 * 1000,
  daily: 10 * 60 * 1000,
  realtime: 0,
};
