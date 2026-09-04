// HTTP guards applied to /mcp only (TRANSPORT=http): DNS-rebinding-safe
// Host/Origin header validation from @modelcontextprotocol/node, plus a
// per-client-IP token bucket. /health and /metrics stay unguarded - they
// carry no request body and no session state worth protecting the same way.
//
// Both guard functions below follow @modelcontextprotocol/node's own
// convention (hostHeaderValidation/originValidation): each one has already
// written the rejection response and the caller must stop dispatching the
// instant it returns false, never call res again itself.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { config } from './config.ts';

// Always allowed regardless of ALEXANDRIA_ALLOWED_ORIGINS: this server's own
// loopback interface (local dev, container-internal health probes, the
// existing test suite, which talks to 127.0.0.1). '[::1]' is the bracketed
// form both guards' own docs specify for an IPv6 literal.
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// Rebuilt on every call, not memoized: this is one array literal and a
// split per request, not a hot loop, and ALEXANDRIA_ALLOWED_ORIGINS is read
// through config.ts's own always-fresh accessor (see its module comment) -
// caching a snapshot here would silently stop tracking a changed env
// between requests, in production and in a test that sets/unsets it.
export function configuredOriginHostnames(): string[] {
  return (config.ALEXANDRIA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function allowedHostnames(): string[] {
  return [...new Set([...LOOPBACK_HOSTNAMES, ...configuredOriginHostnames()])];
}

// The LOCAL end of this connection (which interface it arrived on), not the
// client's address: '127.0.0.1' / '::1' means the listener that answered is
// reachable only from this machine. '::ffff:127.0.0.1' is the IPv4-mapped
// form Node reports for an IPv4 client on a dual-stack listener.
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.replace(/^::ffff:/i, '');
  return bare === '::1' || bare.startsWith('127.');
}

/**
 * Validates the request's Host and Origin headers against
 * ALEXANDRIA_ALLOWED_ORIGINS (plus loopback, always). Returns false when the
 * request was already rejected (403) - the caller must not handle it
 * further in that case.
 *
 * Final wave (B1): the Host check is conditional. Applied unconditionally
 * it 403s every request to a non-loopback deployment whose operator never
 * set ALEXANDRIA_ALLOWED_ORIGINS (verified live) - the Host header of a
 * real deployment is its own public hostname, which is in no allowlist
 * because there is no allowlist. Host validation exists for DNS-rebinding
 * protection, which is a browser-against-localhost attack, so it applies
 * when there is an allowlist to check against, or when this connection
 * arrived on a loopback interface (the case rebinding actually targets).
 *
 * The Origin check is unconditional: the SDK's originValidation passes any
 * request with no Origin header (non-browser MCP clients send none), so a
 * present Origin is always checked against the same list.
 */
export function checkOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const hostnames = allowedHostnames();
  const hostCheckApplies =
    configuredOriginHostnames().length > 0 || isLoopbackAddress(req.socket.localAddress);
  if (hostCheckApplies && !hostHeaderValidation(hostnames)(req, res)) return false;
  if (!originValidation(hostnames)(req, res)) return false;
  return true;
}

// ── Per-client-IP token bucket ───────────────────────────────────────────

const WINDOW_MS = 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// One entry per distinct client IP ever seen, for the life of the process -
// a real, if slow, unbounded-growth vector on a long-running deployment
// with many distinct callers. A hard ceiling bounds the worst case cheaply.
// Generous enough (50,000 distinct IPs before it fires) that it never
// matters for this server's actual traffic shape.
//
// Final wave (B2): past the ceiling, the OLDEST-seen bucket is evicted
// rather than the whole map cleared. Clearing handed every tracked client
// a full bucket at once, so a caller that could reach the ceiling (cheap
// behind a proxy, or by spoofing a header this server is configured to
// trust) could reset its own throttle on demand. A Map iterates in
// insertion order, so its first key is the bucket first seen longest ago;
// evicting that one costs the same as clearing but throws away a single
// client's throttle instead of everyone's.
const MAX_TRACKED_CLIENTS = 50_000;

function evictOldestBucket(): void {
  const oldest = buckets.keys().next();
  if (!oldest.done) buckets.delete(oldest.value);
}

// Task 15 (Controller amendment): behind a reverse proxy (Cloudflare
// Tunnel, a PaaS edge), req.socket.remoteAddress is the proxy's own
// address for every client, collapsing the whole rate limiter into one
// shared bucket. ALEXANDRIA_TRUSTED_PROXY=1 opts into trusting the
// proxy-set headers instead. Unset, or neither header present, falls back
// to the socket address exactly as before - the flag must be an explicit,
// deliberate opt-in (see config.ts's description) since trusting either
// header from an untrusted caller would let it pick its own rate-limit
// bucket.
//
// Final wave (B2): the RIGHTMOST X-Forwarded-For entry, not the leftmost.
// X-Forwarded-For is appended left to right, so the leftmost entry is
// whatever the ORIGINAL caller sent - a client that sends its own
// `X-Forwarded-For: <anything>` header picks its own bucket, and can pick
// a fresh one per request, which is the whole rate limit defeated. The
// rightmost entry is the one appended by the last hop before this server,
// which under this flag is the trusted proxy. CF-Connecting-IP stays
// first: Cloudflare overwrites (not appends) it, so a client-supplied
// value never survives the edge.
function clientKey(req: IncomingMessage): string {
  if (config.ALEXANDRIA_TRUSTED_PROXY === '1') {
    const cfConnectingIp = req.headers['cf-connecting-ip'];
    if (typeof cfConnectingIp === 'string' && cfConnectingIp) return cfConnectingIp;
    const forwardedFor = req.headers['x-forwarded-for'];
    // Node collapses repeated headers into an array; the LAST header line
    // carries the last hop's entries, so the rightmost entry overall is
    // the last entry of the last value.
    const raw = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor;
    const entries = (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const lastEntry = entries.at(-1);
    if (lastEntry) return lastEntry;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function send429(res: ServerResponse): void {
  // A JSON-RPC error body, like every other rejection this server sends on
  // /mcp (see index.ts's jsonRpcErrorHandler) - never a bare HTTP status
  // page. -32000 is the low end of JSON-RPC's reserved "Server error"
  // range (-32000 to -32099), left open for implementation-defined errors
  // like this one; -32603 (Internal error) is reserved for a genuine
  // server-side failure, not a client that sent too many requests.
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'rate limit exceeded' },
    id: null,
  });
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
  res.end(payload);
}

/**
 * Per-client-IP token bucket: ALEXANDRIA_HTTP_RATE_LIMIT tokens (default 60),
 * refilling continuously back up to that cap over a one-minute window.
 * Starts full, so a client's first burst up to the cap is never rejected -
 * only sustained traffic above the per-minute rate is. Returns false (after
 * already sending 429) when the bucket is empty; the caller must not handle
 * the request further in that case.
 */
export function checkRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const limit = config.ALEXANDRIA_HTTP_RATE_LIMIT;
  const key = clientKey(req);
  // Only a key that is about to be ADDED can grow the map, so only that
  // case evicts - a client already tracked at the ceiling must not cost
  // some other client its bucket on every request.
  if (!buckets.has(key) && buckets.size >= MAX_TRACKED_CLIENTS) evictOldestBucket();
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: limit, lastRefill: now };
  const elapsedMs = now - bucket.lastRefill;
  const refilled = Math.min(limit, bucket.tokens + (elapsedMs / WINDOW_MS) * limit);
  bucket.lastRefill = now;
  if (refilled < 1) {
    bucket.tokens = refilled;
    buckets.set(key, bucket);
    send429(res);
    return false;
  }
  bucket.tokens = refilled - 1;
  buckets.set(key, bucket);
  return true;
}

/** Test-only: clears every client's bucket so a rate-limit test starts full. */
export function resetRateLimitForTests(): void {
  buckets.clear();
}

/** Test-only: the ceiling and the live bucket count, for the eviction test. */
export const MAX_TRACKED_CLIENTS_FOR_TESTS = MAX_TRACKED_CLIENTS;
export function trackedClientCountForTests(): number {
  return buckets.size;
}
export function hasTrackedClientForTests(key: string): boolean {
  return buckets.has(key);
}
