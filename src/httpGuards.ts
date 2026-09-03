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
function allowedHostnames(): string[] {
  const configured = (config.ALEXANDRIA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...LOOPBACK_HOSTNAMES, ...configured])];
}

/**
 * Validates the request's Host and Origin headers against
 * ALEXANDRIA_ALLOWED_ORIGINS (plus loopback, always). Returns false when the
 * request was already rejected (403) - the caller must not handle it
 * further in that case.
 */
export function checkOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const hostnames = allowedHostnames();
  if (!hostHeaderValidation(hostnames)(req, res)) return false;
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
// with many distinct callers. A hard ceiling bounds the worst case cheaply:
// once past it, the whole map is dropped and every bucket starts full
// again, which is a harmless one-off (a brief window of un-rate-limited
// traffic) next to holding a Map that grows forever. Generous enough
// (50,000 distinct IPs before it fires) that it never matters for this
// server's actual traffic shape.
const MAX_TRACKED_CLIENTS = 50_000;

function clientKey(req: IncomingMessage): string {
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
  if (buckets.size > MAX_TRACKED_CLIENTS) buckets.clear();
  const limit = config.ALEXANDRIA_HTTP_RATE_LIMIT;
  const key = clientKey(req);
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
