export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
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
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`);
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
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`);
  }

  return response.text();
}
