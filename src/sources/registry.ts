import { config } from '../config.ts';
import type { LibraryResult, ReadResult } from '../types.ts';
import { requestContext } from '../utils/http.ts';
import { sourceMetrics } from '../utils/metrics.ts';
import {
  createLedger,
  type LedgerStore,
  QuotaExceededError,
  reserveQuota,
  utcDay,
} from '../utils/quotaLedger.ts';
import { rateLimited } from '../utils/rateLimit.ts';
import { cacheKey, searchCache } from '../utils/resultCache.ts';
import { stateStore } from '../utils/stateStore.ts';

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
  // Env vars the source reads but does not require: the source works
  // without them, they only raise a quota, unlock a better backend, or
  // add an optional capability. Unlike `auth` these never hide a source.
  // scripts/gen-docs.ts emits them into .env.example so a reader can find
  // every key the code looks at, not just the mandatory ones.
  optionalEnv?: string[];
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

// Deferred to the first guarded call rather than built here at module load:
// createLedger() reads config.ALEXANDRIA_LEDGER/SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY, and a single config field access runs the
// full schema.safeParse(process.env) (see config.ts's module comment).
// registry.ts is imported by nearly everything (gen-docs, probe,
// eval-routing, every registry test), so building the ledger eagerly here
// meant an unrelated malformed ambient var (a bad TRANSPORT or PORT)
// threw at the least diagnosable point: merely importing this module,
// before main() ever ran. See index.ts's main(), which now calls
// loadConfig() explicitly as its first statement so that failure still
// surfaces immediately and readably at real startup.
let ledgerInstance: LedgerStore | undefined;
function getLedger(): LedgerStore {
  if (!ledgerInstance) ledgerInstance = createLedger();
  return ledgerInstance;
}

// True when a source needs no key (auth undefined or type 'none'), or its
// configured env var is present.
export function isConfigured(auth?: AuthSpec): boolean {
  if (!auth || auth.type === 'none') return true;
  return Boolean(auth.env && process.env[auth.env]);
}

// Throws the standard "<name> requires <ENV>" message when an env var a
// source cannot work without is absent. scripts/probe.ts's classify()
// matches that exact wording to report KEY_MISSING instead of ERROR, so
// hand-written adapters must use this rather than their own phrasing.
export function requireKey(name: string, env: string): string {
  const value = process.env[env];
  if (!value) throw new Error(`${name} requires ${env}`);
  return value;
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
// Also aborts `controller` on that same deadline, so http.ts's
// fetchWithRetry() (which reads the ambient signal `controller.signal` is
// wired to via requestContext, see withGuards()) cancels its in-flight
// fetch and stops retrying instead of continuing after this caller has
// already given up.
// A distinct subclass (message text unchanged, so scripts/probe.ts's
// /abort/i match still holds) lets withGuards() below classify a guard
// timeout into metrics.ts's `timeouts` counter via `instanceof` rather than
// string-matching the message a second time.
export class GuardTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new GuardTimeoutError('This operation was aborted');
      controller.abort(err);
      reject(err);
    }, ms);
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
// pacing), per-source pacing, a daily quota ledger, and a call timeout.
//
// Order matters. Pacing is the OUTERMOST guard, and both the quota
// reservation and the timeout live inside the paced callback:
//
//   rateLimited(...) -> reserveQuota(...) -> withTimeout(adapter.call())
//
// Reserving quota or starting the timer before the pacing wait made every
// slow-paced source (ghsa at 60s without a key, nvd at 6.5s,
// courtlistener at 12s) fail with "This operation was aborted" while it
// was still sitting in the queue, and burn a quota unit for a call that
// never reached the provider. With this order the timeout measures only
// the provider call, and a request that is abandoned in the queue costs
// no quota.
//
// The tradeoff, stated plainly: the queue wait itself is UNCAPPED. A
// caller behind a long pacing queue can wait far longer than timeoutMs
// before its call starts. Callers that need a hard wall-clock ceiling
// must impose it themselves (the fan-out in the tools layer does, via its
// own budget); timeoutMs is deliberately a per-call budget, not an
// end-to-end one.
//
// reserveQuota() reserves the slot atomically before the call runs (see
// quotaLedger.ts), so a failed or timed-out call still consumes it; there
// is no separate finally-recorded-usage step to undo on failure.
// Chains a fresh inner AbortController to whatever ambient signal is
// already in requestContext's store, if any (a nested guarded call: one
// adapter's search()/read() calling getAdapter(other).search()/read()
// from inside its own withGuards() scope). AsyncLocalStorage.run() shadows
// the outer store for the inner scope, so without this, code inside the
// inner call only ever sees the inner controller's own signal and the
// inner fetch is never cancelled when the outer caller times out or
// aborts; the inner call just keeps running until its own (typically much
// later) timeout, wasting the underlying request. Returns a cleanup
// function that removes the listener once the inner call settles, so it
// doesn't outlive the call it was attached to.
function chainAbort(inner: AbortController): () => void {
  const outer = requestContext.getStore()?.signal;
  if (!outer) return () => {};
  if (outer.aborted) {
    inner.abort(outer.reason);
    return () => {};
  }
  const onOuterAbort = () => inner.abort(outer.reason);
  outer.addEventListener('abort', onOuterAbort, { once: true });
  return () => outer.removeEventListener('abort', onOuterAbort);
}

// Runs `fn` inside a fresh signal (chained/merged with whatever's already
// ambient, see chainAbort()/this function) while keeping the outer store's
// reqId/tool (set by index.ts's withRequestContext() around the whole MCP
// tool call) intact, so log.ts's requestLogger() and providers.ts's
// llmCalls counter can still attribute to that tool from inside a guarded
// adapter call. A plain `requestContext.run({ signal }, fn)` would instead
// REPLACE the store for this inner scope, dropping reqId/tool.
function runGuarded<T>(controller: AbortController, fn: () => Promise<T>): Promise<T> {
  const outer = requestContext.getStore();
  return requestContext.run({ ...outer, signal: controller.signal }, fn);
}

// Classifies a failed guarded call into exactly one of metrics.ts's
// error-shaped counters (quotaRejections / timeouts / errors), mutually
// exclusive so `calls` decomposes cleanly into "succeeded" plus these three.
function recordFailure(metrics: ReturnType<typeof sourceMetrics>, err: unknown): void {
  if (err instanceof QuotaExceededError) metrics.quotaRejections++;
  else if (err instanceof GuardTimeoutError) metrics.timeouts++;
  else metrics.errors++;
}

function withGuards(name: string, adapter: RegisteredEntry): SourceAdapter {
  return {
    ...adapter,
    async search(query, limit) {
      const key = cacheKey(name, query, limit);
      const cached = searchCache.get(key);
      const metrics = sourceMetrics(name);
      if (cached) {
        metrics.cacheHits++;
        return cached;
      }
      const controller = new AbortController();
      const unchain = chainAbort(controller);
      metrics.calls++;
      try {
        const result = await rateLimited(name, adapter.pacing?.minIntervalMs ?? 0, async () => {
          await reserveQuota(name, adapter.pacing?.dailyCap, getLedger());
          // Timed from here, not from the top of search(): rateLimited()'s
          // wait for a pacing slot and reserveQuota() both happen above
          // this line, so a paced source (ghsa at 60s, nvd at 6.5s, ...)
          // no longer shows its queue wait as provider latency.
          const start = Date.now();
          try {
            return await withTimeout(
              runGuarded(controller, () => adapter.search(query, limit)),
              adapter.timeoutMs,
              controller,
            );
          } finally {
            metrics.latencyMsTotal += Date.now() - start;
          }
        });
        searchCache.set(key, result);
        return result;
      } catch (err) {
        recordFailure(metrics, err);
        throw err;
      } finally {
        unchain();
      }
    },
    async read(id) {
      const controller = new AbortController();
      const unchain = chainAbort(controller);
      const metrics = sourceMetrics(name);
      metrics.calls++;
      try {
        return await rateLimited(name, adapter.pacing?.minIntervalMs ?? 0, async () => {
          await reserveQuota(name, adapter.pacing?.dailyCap, getLedger());
          const start = Date.now();
          try {
            return await withTimeout(
              runGuarded(controller, () => adapter.read(id)),
              adapter.timeoutMs,
              controller,
            );
          } finally {
            metrics.latencyMsTotal += Date.now() - start;
          }
        });
      } catch (err) {
        recordFailure(metrics, err);
        throw err;
      } finally {
        unchain();
      }
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
    optionalEnv: adapter.optionalEnv,
  }));
}

// /health summary: total sources, how many are visible vs hidden (needs a
// key or config not present in this deployment), and a count per kind
// across every registered source (visible and hidden alike).
export function healthSummary(): {
  sources: number;
  visible: number;
  hidden: number;
  byKind: Record<SourceKind, number>;
  quota: { day: string; reserved: number; sources: number; backend: 'state' | 'supabase' };
  cache: { entries: number };
} {
  const all = listSources();
  const byKind: Record<SourceKind, number> = { rest: 0, hub: 0, rss: 0, mcp: 0, scrape: 0 };
  for (const s of all) byKind[s.kind]++;
  const hidden = all.filter((s) => s.hidden).length;
  // Reads the Task 4 store directly, so this reflects whatever ledger
  // backend createLedger() actually wired up by default (sqlite or
  // memory). When ALEXANDRIA_LEDGER=supabase is configured, reservations
  // go to Supabase instead and never touch this store, so these numbers
  // read as zero in that deployment mode; that mode has its own quota
  // visibility via the quota_ledger table. `backend` below (final wave,
  // B4) names which one this payload's quota numbers actually came from,
  // the same condition createLedger() itself gates on, so a supabase
  // deployment's zeros here read as "wrong backend for this view", not
  // "no quota used today".
  //
  // One bulk read (quotaForDay), not one getQuota() round trip per
  // registered source (~138 of them): a row only exists once something
  // reserved against it, so the map's size is already "sources with any
  // usage today" and its values sum to the day's total.
  const day = utcDay();
  const perSource = stateStore.quotaForDay(day);
  let reserved = 0;
  for (const n of perSource.values()) reserved += n;
  const backend: 'state' | 'supabase' =
    config.ALEXANDRIA_LEDGER === 'supabase' &&
    config.SUPABASE_URL &&
    config.SUPABASE_SERVICE_ROLE_KEY
      ? 'supabase'
      : 'state';
  // Final wave, B3: cacheSize() is a raw row/entry count that can include
  // rows already past their expiresAt but not yet lazily evicted (nothing
  // reads them, so nothing has triggered their removal) - evict first so
  // /health's cache.entries reflects what is actually still live, not a
  // count inflated by however much cruft happens to be sitting around
  // since the last read that touched those particular keys.
  stateStore.evictExpired();
  return {
    sources: all.length,
    visible: all.length - hidden,
    hidden,
    byKind,
    quota: { day, reserved, sources: perSource.size, backend },
    cache: { entries: stateStore.cacheSize() },
  };
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
