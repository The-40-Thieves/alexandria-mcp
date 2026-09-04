import { AsyncLocalStorage } from 'node:async_hooks';
import type { Dispatcher } from 'undici';
import {
  assertFetchableUrl,
  configuredServiceOrigins,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
} from '../web/urlGuard.ts';
import { isSensitiveKey } from './secretWords.ts';
import { fetchUserAgent } from './userAgent.ts';

// The ambient global RequestInit (from @types/node) has no `dispatcher`
// field under this project's tsconfig, so options that want one are typed
// through this intersection rather than the bare global RequestInit.
export type FetchOptions = RequestInit & { dispatcher?: Dispatcher };

export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

// Task 5 (review 3.6): reqId/tool ride the same store as the ambient abort
// signal rather than a second AsyncLocalStorage, so any code already
// reading one (fetchWithRetry, mcpClientPool.ts, registry.ts's
// chainAbort()) sees the others for free. `signal` stays as it was: set up
// by registry.ts's withGuards() around one adapter search()/read() call, so
// fetchWithRetry() can cancel an in-flight fetch the instant that guard's
// timeout or the caller's own abort fires, instead of the retry loop
// running to completion after the caller already stopped waiting.
// `reqId`/`tool` are set once, wider: index.ts wraps an entire MCP tool
// invocation in requestContext.run() with them (see withRequestContext()),
// so log.ts's child logger and providers.ts's llmCalls counter can attribute
// to "which tool call is this" without threading an extra parameter through
// every call in between. registry.ts's own inner run() (a narrower, signal-
// only scope nested inside that wider one) merges the outer store in rather
// than replacing it, so reqId/tool survive into a guarded adapter call too.
export interface RequestContextStore {
  signal?: AbortSignal;
  reqId?: string;
  tool?: string;
}
export const requestContext = new AsyncLocalStorage<RequestContextStore>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// About a dozen source adapters (congress, eia, govinfo, smithsonian,
// springer, newsdata, regulations, googlebooks, openalex, ctext, and
// others - `rg -n 'api_key|apikey|key=' src/sources`) pass their API key
// in the query string rather than a header. fetchJSON/fetchText below put
// the request URL verbatim into a thrown Error's message, and
// scripts/probe.ts captures that message into eval/probe-latest.json,
// which .github/workflows/probe.yml uploads as a public artifact and
// interpolates into a public issue on a public repo - so any query
// parameter whose name reads as a credential (the same word test
// src/log.ts's redaction uses, via utils/secretWords.ts) is masked before
// the URL ever reaches an error message. Falls back to returning the URL
// unchanged if it doesn't parse as a URL at all.
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key)) parsed.searchParams.set(key, '[Redacted]');
  }
  return parsed.toString();
}

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');
  const ambient = requestContext.getStore()?.signal;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    if (ambient?.aborted) throw ambient.reason ?? new Error('This operation was aborted');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = ambient ? AbortSignal.any([controller.signal, ambient]) : controller.signal;

    try {
      // Node's global fetch is its OWN bundled undici build. The `undici`
      // package this repo installs for Agent/interceptors
      // (src/utils/dispatcher.ts) is kept on the 7.x line (package.json:
      // "^7.29.0") as conservatism - 7.x is current and maintained - but it
      // is also a reproduced (not merely asserted) requirement for exactly
      // this call site: an explicit `dispatcher` option, like the one
      // fetchTier.ts's guarded fetches pass, is handed by Node's bundled
      // fetch straight to the Agent's own dispatch(), with no version
      // compatibility shim in between (that shim exists in undici 8.x, but
      // only inside setGlobalDispatcher() - irrelevant to an explicit
      // per-call option). Reproduced live on Node 24.20.0 (bundled undici
      // 7.29.0) with the installed package temporarily bumped to 8.10.1:
      // this exact call shape throws "invalid onRequestStart method" (code
      // UND_ERR_INVALID_ARG). See dispatcher.ts's module comment for the
      // full mechanism, the exact reproduction command, and the report.
      const response = await fetch(url, {
        ...options,
        signal,
        headers: {
          // Final wave (F1): one honest UA for every outbound call - see
          // utils/userAgent.ts. This used to send
          // `library-mcp-server/1.0 (open source research tool)`, a name
          // this project has not used since it was renamed and a version
          // that was never true, on the path every REST adapter takes.
          'User-Agent': fetchUserAgent(),
          ...options.headers,
        },
      });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (ambient?.aborted) throw ambient.reason ?? lastError;
      // Don't retry on abort (timeout) for last attempt
      if (attempt === retries) break;
    }
  }

  throw lastError;
}

// ─── Guarded redirects and a body cap for fetchJSON/fetchText ───────────────
//
// Final wave (C2): both used to hand `fetch` its follow-redirects default
// and then read the whole body with response.json()/response.text(). Every
// REST adapter, the open-access hops, the citation walk, PMC, and doi.org's
// content negotiation go through here, and a redirect destination is
// upstream-controlled - doi.org's especially - so an upstream that answers
// `Location: http://169.254.169.254/...` was followed without a check, and
// an unbounded chunked body was buffered whole after fetchWithRetry had
// already cleared its timeout on the response headers.
/** Default streamed body cap. Override per call with `{ maxBytes }`. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

export type BodyLimitedOptions = FetchOptions & { maxBytes?: number };

// The SSRF guard is applied to every REDIRECT hop, not to the caller's own
// starting URL. Two reasons, both load-bearing:
//   - The starting URL of a fetchJSON/fetchText call is always an adapter's
//     own registered endpoint (a module-level constant, sometimes with a
//     caller-supplied path segment or query appended) or an operator's
//     configured service URL. A `Location` header is the only part of this
//     path an upstream controls, and it is exactly the part that was
//     unchecked.
//   - Some configured endpoints are deliberately private: SEARXNG_URL and
//     CRAWL4AI_URL name hosts on an operator's own tailnet, which the
//     private-range rules refuse by design (fetchTier.ts checks those
//     against configuredServiceOrigins() instead). Guarding hop 0 here
//     would break them, and would put a live DNS lookup in front of every
//     REST adapter call, including in unit tests that mock fetch.
// A redirect that stays inside a configured service origin is allowed for
// the same reason: it is an endpoint this server already calls directly.
async function assertRedirectTargetAllowed(nextUrl: string): Promise<void> {
  try {
    if (configuredServiceOrigins().has(new URL(nextUrl).origin.toLowerCase())) return;
  } catch {
    // Not a parseable URL; assertFetchableUrl below rejects it by shape.
  }
  await assertFetchableUrl(nextUrl);
}

async function fetchGuardedRedirects(
  url: string,
  options: FetchOptions,
  timeoutMs: number,
  retries: number,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    const response = await fetchWithRetry(
      currentUrl,
      { ...options, redirect: 'manual' },
      timeoutMs,
      retries,
    );
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: currentUrl };
    // A redirect hop's body is never read; cancel it so the connection goes
    // back to the pool instead of sitting open until GC.
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`more than ${MAX_REDIRECTS} redirects, url: ${redactUrl(url)}`);
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`redirect with no Location header, url: ${redactUrl(currentUrl)}`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    await assertRedirectTargetAllowed(nextUrl);
    currentUrl = nextUrl;
  }
}

// Streams the body counting bytes and aborts once the running total passes
// the cap, so a server that lies about (or omits) Content-Length cannot
// force this process to buffer an unbounded response after fetchWithRetry's
// per-attempt timer has already been cleared. An honest, oversized
// Content-Length is rejected before a byte is read.
async function readCappedText(response: Response, url: string, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error(
      `response declares ${declared} bytes, over the ${maxBytes}-byte cap, url: ${redactUrl(url)}`,
    );
  }
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `response exceeded the ${maxBytes}-byte cap while streaming, url: ${redactUrl(url)}`,
        );
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return out + decoder.decode();
}

async function fetchGuardedBody(
  url: string,
  options: BodyLimitedOptions,
  timeoutMs: number,
  retries: number,
): Promise<string> {
  const { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, ...init } = options;
  const { response, finalUrl } = await fetchGuardedRedirects(url, init, timeoutMs, retries);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} ${response.statusText}, url: ${redactUrl(url)}`);
  }
  return readCappedText(response, finalUrl, maxBytes);
}

// timeoutMs/retries let a source with a known-slow upstream (e.g. loc.gov's
// collections search, which can take 15-30s to answer) ask for a longer
// per-attempt budget than DEFAULT_TIMEOUT_MS without touching the shared
// default other callers rely on. The registry's own withTimeout (meta.timeoutMs)
// is a separate outer guard and should be set at least as large as this.
export async function fetchJSON<T>(
  url: string,
  options: BodyLimitedOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<T> {
  const raw = await fetchGuardedBody(
    url,
    { ...options, headers: { Accept: 'application/json', ...options.headers } },
    timeoutMs,
    retries,
  );
  return JSON.parse(raw) as T;
}

export async function fetchText(
  url: string,
  options: BodyLimitedOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<string> {
  return fetchGuardedBody(url, options, timeoutMs, retries);
}

// Parses a Retry-After header (delta-seconds or an HTTP-date, RFC 9110
// section 10.2.3) into a sleep duration in ms, capped at capMs so a caller
// never sleeps longer than that regardless of what the header asks for.
// Returns null when the requested wait exceeds the cap, telling the caller
// not to sleep/retry at all rather than parking a timer well past the
// registry's own guard timeout. A missing, empty, or unparseable header
// falls back to 1000ms, matching a past HTTP-date (already elapsed, so
// there is effectively no wait to honor).
export function retryAfterMs(header: string | null, capMs = 5000): number | null {
  if (!header) return 1000;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) {
    if (asSeconds <= 0) return 1000;
    const ms = asSeconds * 1000;
    return ms <= capMs ? ms : null;
  }

  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    if (delta <= 0) return 1000;
    return delta <= capMs ? delta : null;
  }

  return 1000;
}
