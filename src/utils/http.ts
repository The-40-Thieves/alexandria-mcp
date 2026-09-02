import { AsyncLocalStorage } from 'node:async_hooks';
import type { Dispatcher } from 'undici';

// The ambient global RequestInit (from @types/node) has no `dispatcher`
// field under this project's tsconfig, so options that want one are typed
// through this intersection rather than the bare global RequestInit.
export type FetchOptions = RequestInit & { dispatcher?: Dispatcher };

export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

// An ambient abort signal a caller can set up around a whole call (registry.ts's
// withGuards() does this, scoped to its own timeout). fetchWithRetry() below
// reads it so that once the caller has given up, the in-flight fetch attempt
// is cancelled immediately and no further retry is started, instead of the
// retry loop running to completion after the caller already stopped waiting.
export const requestContext = new AsyncLocalStorage<{ signal: AbortSignal }>();

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
      // (src/utils/dispatcher.ts) is pinned in package.json to the EXACT
      // version Node 24 currently bundles, specifically so that an explicit
      // `dispatcher` option built by that package is accepted here by the
      // ambient global fetch (a different major throws "invalid
      // onRequestStart method" - see dispatcher.ts's module comment and the
      // report for the confirming two-line check). Pinned rather than
      // ranged: this coupling to Node's internal, undocumented bundled
      // version is real and must be re-verified whenever Node's bundled
      // undici moves.
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
