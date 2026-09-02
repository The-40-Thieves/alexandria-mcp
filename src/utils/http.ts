import { AsyncLocalStorage } from 'node:async_hooks';
import type { Dispatcher } from 'undici';

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
          'User-Agent': 'library-mcp-server/1.0 (open source research tool)',
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

// timeoutMs/retries let a source with a known-slow upstream (e.g. loc.gov's
// collections search, which can take 15-30s to answer) ask for a longer
// per-attempt budget than DEFAULT_TIMEOUT_MS without touching the shared
// default other callers rely on. The registry's own withTimeout (meta.timeoutMs)
// is a separate outer guard and should be set at least as large as this.
export async function fetchJSON<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<T> {
  const response = await fetchWithRetry(
    url,
    {
      ...options,
      headers: { Accept: 'application/json', ...options.headers },
    },
    timeoutMs,
    retries,
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}, url: ${url}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchText(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<string> {
  const response = await fetchWithRetry(url, options, timeoutMs, retries);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}, url: ${url}`);
  }

  return response.text();
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
