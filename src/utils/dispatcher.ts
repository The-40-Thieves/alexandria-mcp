// One tuned undici dispatcher shared by every outbound fetch this server
// makes (review 3.3). Two dispatchers, both built with the same connection
// limits:
//
//   sourceDispatcher - installed as the GLOBAL dispatcher (installDispatcher()
//                      below), so every ordinary fetchWithRetry() call in
//                      src/sources/** picks it up automatically with no
//                      per-call change. Adds an undici DNS cache
//                      (interceptors.dns) and an RFC 9111 HTTP cache
//                      (interceptors.cache) backed by SqliteCacheStore.
//   guardedDispatcher  - a plain Agent with no DNS or HTTP-cache interceptor,
//                        used explicitly (never installed globally) by
//                        src/web/fetchTier.ts for fetches of a caller-supplied
//                        URL that assertFetchableUrl() already validated. It
//                        MUST NOT reuse the DNS cache above: a cached answer
//                        for a guarded hostname would let a later guarded
//                        fetch skip validation of a fresh (possibly rebound)
//                        address. See withPinnedAddress() below for how it
//                        closes the TOCTOU gap between validation and connect.
//
// No interceptors.retry on either: fetchWithRetry() (src/utils/http.ts)
// already owns retry and Retry-After parsing; a second retry layer
// underneath it would double the effective retry count and reorder when
// Retry-After is read.
//
// Version note: package.json pins the `undici` dependency to the EXACT
// version Node 24 currently bundles internally (confirmed live:
// process.versions.undici). Node's global fetch() is its own bundled undici
// build; passing it an explicit `dispatcher` built by a DIFFERENT major from
// this package throws ("invalid onRequestStart method" - the two builds'
// internal request-handler protocols aren't cross-compatible), which is
// exactly what fetchTier.ts's guarded fetches need to do (see
// guardedDispatcher below). A dispatcher set globally via
// setGlobalDispatcher() is unaffected by this - confirmed live, see the
// report's two-line check - so sourceDispatcher below has no such
// constraint; only the pinned version protects guardedDispatcher's explicit
// `dispatcher:` fetch option. Re-verify this pin (`node -e
// "console.log(process.versions.undici)"`) whenever Node's version changes.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LookupAddress, LookupOptions } from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, cacheStores, type Dispatcher, interceptors, setGlobalDispatcher } from 'undici';

const CONNECTIONS = 64;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 15_000;
const DNS_MAX_TTL_MS = 60_000;
const CACHE_MAX_SIZE_BYTES = 256 * 1024 * 1024;
const CACHE_MAX_ENTRY_SIZE_BYTES = 5 * 1024 * 1024;

// Resolved from import.meta.dirname rather than process.cwd(), matching
// catalogIndex.ts's DEFAULT_CACHE_PATH: the default must not depend on where
// the process was started. import.meta.dirname is dist/utils/ after a build
// and src/utils/ under native execution, so ../../data lands at the package
// root either way. ALEXANDRIA_HTTP_CACHE overrides it.
const DEFAULT_CACHE_PATH = path.resolve(import.meta.dirname, '../../data/http-cache.db');

function cachePath(): string {
  return process.env.ALEXANDRIA_HTTP_CACHE ?? DEFAULT_CACHE_PATH;
}

let warnedFallback = false;

function warnFallbackOnce(reason: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.error(`[alexandria] http cache: falling back to an in-memory store (${reason})`);
}

/** Test-only: clears the "already warned" latch so a test can observe the warning fire again. */
export function resetHttpCacheWarningForTests(): void {
  warnedFallback = false;
}

// SqliteCacheStore has no maxSize knob (only maxCount and maxEntrySize,
// confirmed against undici's current CacheStore docs) so the 256 MB budget
// from the brief applies to the in-memory fallback, which does support it;
// maxEntrySize (5 MB) applies to both stores.
export function buildCacheStore(
  location: string,
):
  | InstanceType<typeof cacheStores.SqliteCacheStore>
  | InstanceType<typeof cacheStores.MemoryCacheStore> {
  try {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    return new cacheStores.SqliteCacheStore({
      location,
      maxEntrySize: CACHE_MAX_ENTRY_SIZE_BYTES,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnFallbackOnce(`${location}: ${message}`);
    return new cacheStores.MemoryCacheStore({
      maxSize: CACHE_MAX_SIZE_BYTES,
      maxEntrySize: CACHE_MAX_ENTRY_SIZE_BYTES,
    });
  }
}

// ─── guardedDispatcher: pinned-address connect ──────────────────────────────
//
// fetchTier.ts's assertFetchableUrl() resolves and validates a hostname's
// address(es) before any fetch runs. Left alone, the actual TCP connection a
// moment later re-resolves the hostname independently (undici's own
// connector calls dns.lookup itself), so a second DNS answer between
// validation and connect (attacker-controlled DNS, TTL 0, "rebinding") could
// point the real connection at a private address the guard never saw. See
// the module comment above assertFetchableUrl in fetchTier.ts.
//
// withPinnedAddress() closes that gap: fetchTier.ts wraps its guarded fetch
// in withPinnedAddress({hostname, address, family}, ...) using the exact
// address assertFetchableUrl just validated, and guardedDispatcher's
// connect.lookup hook answers ONLY from that pin - it never calls the
// system resolver itself. A guarded fetch issued with no pin in scope fails
// closed (connection refused) rather than silently falling back to a fresh,
// unvalidated DNS lookup.
export interface AddressPin {
  hostname: string;
  address: string;
  family: number;
}

const pinStore = new AsyncLocalStorage<AddressPin>();

export function withPinnedAddress<T>(pin: AddressPin, fn: () => Promise<T>): Promise<T> {
  return pinStore.run(pin, fn);
}

function pinnedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  const pin = pinStore.getStore();
  if (pin && pin.hostname === hostname.toLowerCase()) {
    if (options.all) {
      callback(null, [{ address: pin.address, family: pin.family }]);
    } else {
      callback(null, pin.address, pin.family);
    }
    return;
  }
  callback(
    Object.assign(new Error(`guardedDispatcher: no pinned address for ${hostname}`), {
      code: 'EGUARDNOPIN',
    }),
    '',
  );
}

function buildGuardedDispatcher(): Agent {
  return new Agent({
    connections: CONNECTIONS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    connect: { lookup: pinnedLookup },
  });
}

// A plain Agent, no dns or cache interceptor (see module comment). Built
// once at import: unlike sourceDispatcher below, it opens no file and reads
// no env var, so importing this module never has a filesystem side effect
// on its own.
export const guardedDispatcher: Dispatcher = buildGuardedDispatcher();

// ─── sourceDispatcher: dns cache + RFC 9111 http cache ──────────────────────

// Exposed for dispatcher.test.ts (and any other caller that wants a
// dispatcher instance without mutating global state) with an explicit cache
// location, independent of installDispatcher()'s singleton.
export function buildSourceDispatcher(cacheLocation: string = cachePath()): Dispatcher {
  const store = buildCacheStore(cacheLocation);
  return new Agent({
    connections: CONNECTIONS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
  }).compose([
    // affinity: 4 - measured live against this deployment's egress
    // (huggingface.co's MCP endpoint, dual-stack): the plain default Node
    // connector this dispatcher replaces falls back from an unreachable
    // IPv6 answer to IPv4 automatically, but interceptors.dns's own address
    // selection does not retry across families on a failed connection, so
    // the first (here, IPv6) answer it hands out is final. Forcing IPv4
    // avoids depending on this box's IPv6 egress being reliable for every
    // third-party origin the registry's ~130 sources reach.
    interceptors.dns({ maxTTL: DNS_MAX_TTL_MS, affinity: 4 }),
    interceptors.cache({ store }),
  ]);
}

// The composed agent installDispatcher() sets as the process-wide global
// dispatcher. Not built eagerly at module load (unlike guardedDispatcher
// above): building it opens/creates a SQLite file, and dispatcher.ts is
// imported transitively by every test that touches fetchTier.ts, so an
// eager build here would create data/http-cache.db (or fail over to memory)
// on every one of those imports rather than only when a caller actually
// wants the installed dispatcher. installDispatcher() below is the only
// thing that populates this binding, and it is idempotent.
export let sourceDispatcher: Dispatcher | undefined;

let installed = false;

/**
 * Builds sourceDispatcher (if not already built) and sets it as undici's
 * global dispatcher, so every fetch this process makes through the global
 * fetch() - which is what fetchWithRetry() calls - reuses pooled
 * connections, a DNS cache, and an RFC 9111 HTTP cache. Idempotent: a second
 * call is a no-op, so index.ts, scripts/probe.ts, and scripts/eval-routing.ts
 * can each call it at startup without re-building the dispatcher or
 * re-opening the cache database.
 */
export function installDispatcher(): void {
  if (installed) return;
  installed = true;
  sourceDispatcher = buildSourceDispatcher();
  setGlobalDispatcher(sourceDispatcher);
}
