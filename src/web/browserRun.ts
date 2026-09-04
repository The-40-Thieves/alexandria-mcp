// Fetch tier 4 (task 15): Cloudflare Browser Run's REST /markdown Quick
// Action - a hosted headless Chrome render, the same shape as tier 2
// (jina) and tier 3 (crawl4ai): only tried when configured
// (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_BROWSER_RUN_TOKEN), after crawl4ai,
// so a self-hosted crawl4ai instance is preferred over a billed Cloudflare
// call when both happen to be configured. See docs/cloudflare.md for the
// pricing/limits/bot-posture context and why this sits last in the chain.
//
// Endpoint and response shape verified against Cloudflare's own docs
// (context7 `/websites/developers_cloudflare_browser-run`) before writing:
// POST https://api.cloudflare.com/client/v4/accounts/<id>/browser-rendering/markdown
// with {url}, Authorization: Bearer <token>, returns
// {success, result?: string, errors?: [{code, message}]}.
//
// SECURITY: same defense-in-depth re-check as tiers 2/3 - fetchAsText()
// already guards `url` before any tier runs, but this tier hands the URL
// to a third party (Cloudflare) to fetch on this process's behalf, so a
// private target reaching it would leak it to that third party, not just
// waste a call.
import { config } from '../config.ts';
import { fetchWithRetry } from '../utils/http.ts';
import {
  assertFetchableUrl,
  FETCH_TIMEOUT_MS,
  type FetchedPage,
  readCappedText,
} from './fetchTier.ts';

interface BrowserRunError {
  code?: number;
  message?: string;
}

interface BrowserRunMarkdownResponse {
  success?: boolean;
  result?: string;
  errors?: BrowserRunError[];
}

export async function tryBrowserRun(url: string): Promise<FetchedPage> {
  await assertFetchableUrl(url);

  const accountId = config.CLOUDFLARE_ACCOUNT_ID;
  const token = config.CLOUDFLARE_BROWSER_RUN_TOKEN;
  if (!accountId || !token) {
    throw new Error('browser-run: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_BROWSER_RUN_TOKEN not set');
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;
  const response = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Never logged: fetchWithRetry/readCappedText only ever put the
        // request URL (never headers) into a thrown error message, and
        // this token is never echoed back into `text`/`title` below.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url }),
    },
    FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`browser-run: HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }

  const raw = await readCappedText(response, url, 'browser-run');
  let data: BrowserRunMarkdownResponse;
  try {
    data = JSON.parse(raw) as BrowserRunMarkdownResponse;
  } catch {
    throw new Error(`browser-run: non-JSON response for ${url}`);
  }
  if (!data.success || typeof data.result !== 'string') {
    const detail = (data.errors ?? [])
      .map((e) => e.message)
      .filter((m): m is string => Boolean(m))
      .join('; ');
    throw new Error(`browser-run: failed to render ${url}${detail ? ` (${detail})` : ''}`);
  }

  const text = data.result.trim();
  if (!text) throw new Error(`browser-run: empty markdown for ${url}`);
  return { url, title: url, text, via: 'browser-run' };
}
