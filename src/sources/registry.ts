import type { LibraryResult, ReadResult } from '../types.js';
import { createLedger, type LedgerStore, reserveQuota } from '../utils/quotaLedger.js';
import { rateLimited } from '../utils/rateLimit.js';
import { cacheKey, searchCache } from '../utils/resultCache.js';

export type SourceKind = 'rest' | 'hub' | 'rss' | 'mcp' | 'scrape';
export type Freshness = 'realtime' | 'daily' | 'static';
export type Cluster =
  | 'literature'
  | 'culture'
  | 'archives'
  | 'academic'
  | 'science'
  | 'government'
  | 'law'
  | 'security'
  | 'developer'
  | 'standards'
  | 'markets'
  | 'economics'
  | 'real_estate'
  | 'news_global'
  | 'news_regional'
  | 'geopolitical'
  | 'ai_research'
  | 'video'
  | 'web';

export interface AuthSpec {
  type: 'none' | 'query' | 'header' | 'bearer';
  env?: string;
  param?: string;
  header?: string;
}

export interface SourceMeta {
  kind: SourceKind;
  cluster: Cluster;
  freshness: Freshness;
  homepage?: string;
  timeoutMs?: number; // default 15000
  headers?: Record<string, string>;
  auth?: AuthSpec; // informational + used by kinds/rest.ts
  pacing?: { minIntervalMs?: number; dailyCap?: number };
  verifiedAt?: string; // ISO date the adapter was last probed OK by a human/CI
  hidden?: boolean; // registered but excluded from routing (e.g., needs a key not present)
}

export interface SourceAdapter extends Partial<SourceMeta> {
  description: string;
  supportsIngest: boolean; // does this source have retrievable plain text?
  search(query: string, limit: number): Promise<LibraryResult[]>;
  read(id: string): Promise<ReadResult>;
}

interface RegisteredEntry extends SourceAdapter {
  kind: SourceKind;
  cluster: Cluster;
  freshness: Freshness;
  timeoutMs: number;
  hidden: boolean;
}

const DEFAULTS = {
  kind: 'rest' as SourceKind,
  cluster: 'literature' as Cluster,
  freshness: 'static' as Freshness,
  timeoutMs: 15000,
};

const REGISTRY = new Map<string, RegisteredEntry>();
const WRAPPED = new Map<string, SourceAdapter>();
const ledger: LedgerStore = createLedger();

// True when a source needs no key (auth undefined or type 'none'), or its
// configured env var is present.
export function isConfigured(auth?: AuthSpec): boolean {
  if (!auth || auth.type === 'none') return true;
  return Boolean(auth.env && process.env[auth.env]);
}

export function register(name: string, adapter: SourceAdapter): void {
  const hidden = adapter.hidden ?? (adapter.auth ? !isConfigured(adapter.auth) : false);
  REGISTRY.set(name, {
    ...adapter,
    kind: adapter.kind ?? DEFAULTS.kind,
    cluster: adapter.cluster ?? DEFAULTS.cluster,
    freshness: adapter.freshness ?? DEFAULTS.freshness,
    timeoutMs: adapter.timeoutMs ?? DEFAULTS.timeoutMs,
    hidden,
  });
  WRAPPED.delete(name); // invalidate a memoized wrapper from an earlier registration
}

// Rejects with the message existing callers already match on (e.g.
// scripts/probe.ts's classify()'s /abort/i test) once `meta.timeoutMs`
// elapses, whichever of the underlying call or the timer settles first.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('This operation was aborted')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Wraps a registered adapter with the guards every source inherits: a
// result cache ahead of everything else (cache hits skip quota and
// pacing), a daily quota ledger, per-source pacing, and a call timeout.
//
// reserveQuota() reserves the slot atomically before the call runs (see
// quotaLedger.ts), so a failed or timed-out call still consumes it; there
// is no separate finally-recorded-usage step to undo on failure.
function withGuards(name: string, adapter: RegisteredEntry): SourceAdapter {
  return {
    ...adapter,
    async search(query, limit) {
      const key = cacheKey(name, query, limit);
      const cached = searchCache.get(key);
      if (cached) return cached;
      await reserveQuota(name, adapter.pacing?.dailyCap, ledger);
      const result = await withTimeout(
        rateLimited(name, adapter.pacing?.minIntervalMs ?? 0, () => adapter.search(query, limit)),
        adapter.timeoutMs,
      );
      searchCache.set(key, result);
      return result;
    },
    async read(id) {
      await reserveQuota(name, adapter.pacing?.dailyCap, ledger);
      return await withTimeout(
        rateLimited(name, adapter.pacing?.minIntervalMs ?? 0, () => adapter.read(id)),
        adapter.timeoutMs,
      );
    },
  };
}

export function getAdapter(name: string): SourceAdapter {
  const adapter = REGISTRY.get(name);
  if (!adapter) {
    const available = [...REGISTRY.keys()].sort().join(', ');
    throw new Error(`Unknown source: "${name}". ` + `Available sources: ${available}`);
  }
  let wrapped = WRAPPED.get(name);
  if (!wrapped) {
    wrapped = withGuards(name, adapter);
    WRAPPED.set(name, wrapped);
  }
  return wrapped;
}

export function listSources(): Array<
  { name: string; description: string; supportsIngest: boolean } & SourceMeta
> {
  return [...REGISTRY.entries()].map(([name, adapter]) => ({
    name,
    description: adapter.description,
    supportsIngest: adapter.supportsIngest,
    kind: adapter.kind,
    cluster: adapter.cluster,
    freshness: adapter.freshness,
    homepage: adapter.homepage,
    timeoutMs: adapter.timeoutMs,
    headers: adapter.headers,
    auth: adapter.auth,
    pacing: adapter.pacing,
    verifiedAt: adapter.verifiedAt,
    hidden: adapter.hidden,
  }));
}

// Routing view: every non-hidden source, trimmed to what routing needs.
export function catalog(): Array<{
  name: string;
  description: string;
  cluster: Cluster;
  freshness: Freshness;
  kind: SourceKind;
}> {
  return listSources()
    .filter((s) => !s.hidden)
    .map((s) => ({
      name: s.name,
      description: s.description,
      cluster: s.cluster,
      freshness: s.freshness,
      kind: s.kind,
    }));
}

// ─── Max chars for library_read ────────────────────────────────────────────
export const READ_MAX_CHARS = 200_000;

export function truncateText(text: string): {
  text: string;
  charCount: number;
  truncated: boolean;
  truncatedAt?: number;
} {
  const charCount = text.length;
  const truncated = charCount > READ_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, READ_MAX_CHARS) : text,
    charCount,
    truncated,
    truncatedAt: truncated ? READ_MAX_CHARS : undefined,
  };
}
