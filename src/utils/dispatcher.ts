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
// Version note: package.json pins the `undici` dependency to ^7.29.0.
// This is conservatism, not a version-matching requirement - 7.x is the
// current, maintained undici line and there is no reason to move ahead of
// it. The specific, reproduced reason to stay off 8.x while this repo still
// supports Node 24 (mechanism traced in node_modules/undici's own source,
// result reproduced live and TWICE on this exact box, not merely asserted):
//
//   - Node's global fetch() is Node's OWN bundled undici build (7.29.0 on
//     Node 24.20.0, checked via process.versions.undici).
//   - undici 8.x DOES carry a legacy-handler compatibility shim
//     (Dispatcher1Wrapper/LegacyHandlerWrapper, lib/dispatcher/
//     dispatcher1-wrapper.js) - but it is wired in ONLY inside
//     setGlobalDispatcher() (lib/global.js): that function publishes both
//     the agent itself (current-shape symbol) AND a Dispatcher1Wrapper-
//     wrapped copy under the OLD global-dispatcher symbol
//     (Symbol.for('undici.globalDispatcher.1')), which is what Node's OWN
//     bundled 7.x fetch reads when no explicit `dispatcher` option is
//     given. That is why a dispatcher installed via setGlobalDispatcher()
//     works regardless of the installed undici package's major version
//     (reproduced live both directions - see the report's two-line check
//     and its undici-8.x re-run) - sourceDispatcher below has no
//     version constraint for exactly this reason.
//   - An EXPLICIT `dispatcher` option on a fetch call (guardedDispatcher's
//     pattern, in fetchTier.ts) bypasses that global-symbol lookup and
//     global.js's wrapping entirely: Node's bundled 7.x fetch hands the RAW
//     Agent (unwrapped) a legacy-shape handler
//     (onConnect/onHeaders/onData/onComplete) directly. undici 7.x's own
//     Agent.dispatch() -> assertRequestHandler accepts that legacy shape
//     natively (confirmed against node_modules/undici/lib/core/util.js);
//     undici 8.x's does not (assertRequestHandler there requires the
//     current onRequestStart shape), so it throws.
//
// Reproduced on this box, Node v24.20.0 (bundled undici 7.29.0), package
// undici temporarily bumped to 8.10.1 (`npm install undici@8.10.1
// --no-save`): passing `new Agent()` or an Agent with `connect.lookup` set
// (guardedDispatcher's own shape) as an explicit `{ dispatcher }` option to
// the real global fetch() throws `InvalidArgumentError: invalid
// onRequestStart method` (code UND_ERR_INVALID_ARG) both times, run twice
// for reproducibility. A composed dns+cache Agent (sourceDispatcher's
// shape) does not throw that same error under the same conditions but hangs
// instead - also a failure, just a different failure mode - though
// sourceDispatcher never takes this explicit-option code path in
// production. dispatcher.test.ts's "global fetch honors an explicit
// dispatcher option" test exercises exactly guardedDispatcher's own shape
// through the real global fetch and is a genuine, currently-passing
// regression trap for this constraint: it fails the same way the moment a
// dependency bump moves this package to 8.x while Node 24 is still
// supported (verified by temporarily bumping the installed package and
// re-running the suite).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LookupAddress, LookupOptions } from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, cacheStores, type Dispatcher, interceptors, setGlobalDispatcher } from 'undici';
import { config } from '../config.ts';
import { log } from '../log.ts';

const CONNECTIONS = 64;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 15_000;
const DNS_MAX_TTL_MS = 60_000;
const CACHE_MAX_SIZE_BYTES = 256 * 1024 * 1024;
const CACHE_MAX_ENTRY_SIZE_BYTES = 1 * 1024 * 1024;

// Resolved from import.meta.dirname rather than process.cwd(), matching
// catalogIndex.ts's DEFAULT_CACHE_PATH: the default must not depend on where
// the process was started. import.meta.dirname is dist/utils/ after a build
// and src/utils/ under native execution, so ../../data lands at the package
// root either way. ALEXANDRIA_HTTP_CACHE overrides it.
const DEFAULT_CACHE_PATH = path.resolve(import.meta.dirname, '../../data/http-cache.db');

function cachePath(): string {
  return config.ALEXANDRIA_HTTP_CACHE ?? DEFAULT_CACHE_PATH;
}

let warnedFallback = false;

function warnFallbackOnce(reason: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  log.warn({ reason }, 'http cache: falling back to an in-memory store');
}

/** Test-only: clears the "already warned" latch so a test can observe the warning fire again. */
export function resetHttpCacheWarningForTests(): void {
  warnedFallback = false;
}

// SqliteCacheStore has no maxSize (total-bytes) knob - only maxCount and
// maxEntrySize (confirmed against undici's current CacheStore docs), so the
// 256 MB budget can only be applied there via maxCount * maxEntrySize.
// 256 * 1 MB = 256 MB exactly: SQLITE_MAX_COUNT (256) times
// CACHE_MAX_ENTRY_SIZE_BYTES (1 MB) is the worst-case bound - on-disk usage
// can never exceed the budget regardless of what gets cached, even if every
// single entry hit the maxEntrySize ceiling.
//
// maxEntrySize is 1 MB rather than the brief's original 5 MB (a controller
// ruling on review, replacing the round-1 fix's maxCount=51/maxEntrySize=5 MB
// pair, which bounded disk usage correctly but left too little cross-run
// capacity for ~130 distinct origins at the same 256 MB budget). Most of
// this registry's responses (JSON API pages, RSS/HTML) are well under 1 MB,
// so raising maxCount 5x (51 -> 256) for a lower per-entry ceiling trades
// away caching the occasional large response for caching far more distinct
// URLs, which is the better trade for a dispatcher shared by ~130 sources.
// NOTE on a claim from review: the ruling that set these two values also
// said a response over 1 MB is a full-text read already covered by
// src/utils/resultCache.ts. Checked against src/sources/registry.ts and
// that is not accurate: searchCache there wraps only search(), not read(),
// so a read response over 1 MB is genuinely uncached at every layer here,
// not backed by another cache. The maxCount/capacity tradeoff above (more
// distinct URLs cached vs. occasionally missing a large one) stands on its
// own regardless of that claim.
// MemoryCacheStore (the fallback below) gets the 256 MB budget directly via
// its own maxSize option instead (unchanged); maxEntrySize (1 MB) applies to
// both stores.
const SQLITE_MAX_COUNT = Math.floor(CACHE_MAX_SIZE_BYTES / CACHE_MAX_ENTRY_SIZE_BYTES);

export function buildCacheStore(
  location: string,
):
  | InstanceType<typeof cacheStores.SqliteCacheStore>
  | InstanceType<typeof cacheStores.MemoryCacheStore> {
  try {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    return new cacheStores.SqliteCacheStore({
      location,
      maxCount: SQLITE_MAX_COUNT,
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
// in withPinnedAddress({hostname, addresses}, ...) using the FULL set of
// addresses assertFetchableUrl's successor (resolveFetchTarget) already
// validated - every entry in that set individually passed the guard, so
// none of them needs re-checking here. guardedDispatcher's connect.lookup
// hook answers ONLY from that pin (never calls the system resolver itself),
// and hands back the WHOLE set when Node asks for `{ all: true }` (which is
// what Node's own Happy Eyeballs / autoSelectFamily connect path asks for),
// so a dead or unreachable first address still lets Node fall through to a
// later, validated address instead of failing the whole connection - the
// same failover the plain default connector this dispatcher replaces
// already had via a real dns.lookup(..., { all: true }). A guarded fetch
// issued with no pin in scope fails closed (connection refused) rather
// than silently falling back to a fresh, unvalidated DNS lookup.
export interface AddressPin {
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
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
  if (pin && pin.hostname === hostname.toLowerCase() && pin.addresses.length > 0) {
    if (options.all) {
      callback(null, pin.addresses);
    } else {
      const first = pin.addresses[0];
      callback(null, first.address, first.family);
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
