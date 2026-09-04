// fetchAsText(): the shared web-fetch chain behind the `webfetch` source and
// full-text reads for RSS-kind sources (rss.ts, googlenews.ts). Four tiers,
// tried in order, first one over the success threshold wins:
//
//   1. defuddle    - GET the page directly with a browser UA and run
//                    Defuddle (via linkedom's DOM) locally. No third-party
//                    dependency, works for any page this process can
//                    reach. Follows redirects itself (redirect: 'manual' +
//                    a capped loop, see fetchFollowingRedirects) so every
//                    hop gets the SSRF guard, not just the URL the caller
//                    supplied. When the response is a PDF (by content-type
//                    or a .pdf URL path) this tier extracts it with unpdf
//                    (see pdf.ts) instead of running Defuddle, returning
//                    via: 'pdf' with per-page text.
//   2. jina        - GET https://r.jina.ai/{url}, a hosted reader that
//                    renders JS and strips boilerplate server-side. Only
//                    tried when JINA_API_KEY or ALEXANDRIA_JINA_READER=1 is
//                    set, so an anonymous caller never eats into Jina's 20
//                    RPM shared cap.
//   3. crawl4ai    - POST {CRAWL4AI_URL}/crawl, a self-hosted
//                    headless-browser render (see cave-infra). Only tried
//                    when CRAWL4AI_URL is configured.
//   4. browser-run - POST Cloudflare Browser Run's REST /markdown Quick
//                    Action (src/web/browserRun.ts), a hosted headless
//                    Chrome render. Only tried when CLOUDFLARE_ACCOUNT_ID
//                    and CLOUDFLARE_BROWSER_RUN_TOKEN are both set - see
//                    docs/cloudflare.md.
//
// Tier 1 falls through to tier 2/3/4 when the page isn't HTML, when
// Defuddle can't extract at least MIN_TEXT_CHARS of text (a paywall stub, a
// JS-only shell, a login wall), or when the fetch itself fails. Tiers 2, 3,
// and 4 are tried in order for as long as they're configured; fetchAsText
// throws the last tier's error once every configured tier has failed.
//
// SECURITY: every tier is fetching (or asking a service to fetch, tiers
// 2/3/4) a URL the caller supplied - this whole module is an SSRF surface.
// See ./urlGuard.ts's assertFetchableUrl() for the guard, and its module
// comment for the one documented residual gap (TOCTOU on tiers 2/3/4).

import { config } from '../config.ts';
import { type AddressPin, guardedDispatcher, withPinnedAddress } from '../utils/dispatcher.ts';
import { fetchWithRetry } from '../utils/http.ts';
import { fetchUserAgent } from '../utils/userAgent.ts';
import { tryBrowserRun } from './browserRun.ts';
import { extractHtml, extractPdfOffThread } from './extract.ts';
import type { PdfPage } from './pdf.ts';
import {
  assertConfiguredServiceUrl,
  assertFetchableUrl,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
  resolveFetchTarget,
} from './urlGuard.ts';

// Final wave (C2): the SSRF guard moved to ./urlGuard.ts so utils/http.ts
// can apply it too (this module imports utils/http.ts, so the dependency
// could not go the other way). Only the two names reached for from OUTSIDE
// this module at this path are re-exported: assertFetchableUrl
// (openAccess.ts, mcp/jina.ts, browserRun.ts) and dnsResolver, which a
// dozen adapter tests swap to simulate a hostname resolving privately.
export { assertFetchableUrl, type DnsLookupAll, dnsResolver } from './urlGuard.ts';

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  via: 'defuddle' | 'jina' | 'crawl4ai' | 'browser-run' | 'pdf' | 'markdown';
  // Set only when via === 'pdf': one entry per PDF page, in order. `text`
  // above is these pages' text joined by pdf.ts's PDF_PAGE_JOINER - the
  // library_read handler (src/index.ts) walks that same join to turn this
  // into ReadResult.pages' charStart/charEnd.
  pages?: PdfPage[];
}

// Exported for browserRun.ts (tier 4): a fixed timeout/label shared with
// every other tier rather than a second constant that could drift from
// this one.
export const FETCH_TIMEOUT_MS = 15_000;
const MIN_TEXT_CHARS = 500;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

// ─── Response size cap ──────────────────────────────────────────────────────

// Rejects fast on an honest, oversized Content-Length; otherwise streams the
// body counting bytes and aborts once the running total passes the cap, so a
// server that lies about (or omits) Content-Length can't force this process
// to buffer an unbounded response. Shared by all four tiers (defuddle
// fetches directly; jina, crawl4ai, and browser-run delegate the fetch but
// the response still flows through this process), each tagging its own
// error messages with `label` so a cap failure reads the same way callers
// already expect (`/defuddle:/`, `/jina:/`, `/crawl4ai:/`, `/browser-run:/`
// in fetchAsText's error).
// Byte-level core shared by readCappedText (every existing tier) and the
// PDF branch below (task 6, which needs the raw bytes, not a UTF-8
// decode): same fast-reject-on-declared-size-then-stream-counting shape,
// same per-tier error label, just stopping short of the text decode so a
// binary body doesn't get mangled on its way to extractPdf().
async function readCappedBytes(
  response: Response,
  url: string,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error(
      `${label}: response for ${url} declares ${declared} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap`,
    );
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `${label}: response for ${url} exceeded the ${MAX_RESPONSE_BYTES}-byte cap while streaming`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

// Exported for browserRun.ts (tier 4): the same streaming-cap-then-decode
// path every other tier reads its response through, rather than a second
// implementation of the same size guard.
export async function readCappedText(
  response: Response,
  url: string,
  label: string,
): Promise<string> {
  const bytes = await readCappedBytes(response, url, label);
  return new TextDecoder('utf-8').decode(bytes);
}

// ─── Redirect handling ──────────────────────────────────────────────────────

// Fetches with redirect: 'manual' and follows redirects itself, in a loop
// capped at MAX_REDIRECTS hops, re-running the full SSRF guard on each
// Location before following it. A server error page or a redirect to a
// private address can't be reached by handing fetch() the follow-automatically
// default, since that would only guard the URL the caller supplied and let
// every subsequent hop go unchecked.
//
// This is the one fetch in this module that actually opens a TCP connection
// to a caller-supplied hostname (tryJinaReader/tryCrawl4ai connect to a
// fixed, already-allowlisted service endpoint instead - see their own
// comments), so it is the one that needs guardedDispatcher and the pin:
// every hop's fetch carries dispatcher: guardedDispatcher, and is wrapped in
// withPinnedAddress() with the SAME address resolveFetchTarget() just
// validated that hop's URL against - see resolveFetchTarget's comment for
// why reusing that one lookup (rather than resolving again to build the
// pin) is what actually closes the TOCTOU gap.
async function fetchFollowingRedirects(
  startUrl: string,
  init: RequestInit,
  timeoutMs: number,
  startPin: AddressPin | undefined,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = startUrl;
  let pin = startPin;
  for (let hop = 0; ; hop++) {
    const guardedInit = { ...init, redirect: 'manual' as const, dispatcher: guardedDispatcher };
    const response = pin
      ? await withPinnedAddress(pin, () => fetchWithRetry(currentUrl, guardedInit, timeoutMs))
      : await fetchWithRetry(currentUrl, guardedInit, timeoutMs);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl };
    }
    // A redirect hop's body is never read (redirects carry at most a short
    // HTML stub, if anything); drain/cancel it here so the connection can be
    // released back to the pool instead of sitting open until GC finalizes
    // the unread stream.
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new Error(
        `fetchAsText: more than ${MAX_REDIRECTS} redirects starting from ${startUrl}`,
      );
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`fetchAsText: redirect from ${currentUrl} had no Location header`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const resolved = await resolveFetchTarget(nextUrl);
    pin = resolved.pin;
    currentUrl = nextUrl;
  }
}

// --- Tier 1: defuddle ------------------------------------------------------

async function tryDefuddle(url: string, pin: AddressPin | undefined): Promise<FetchedPage | null> {
  const { response, finalUrl } = await fetchFollowingRedirects(
    url,
    {
      headers: {
        'User-Agent': fetchUserAgent(),
        // Task 13, Cloudflare's "Markdown for Agents": a zone that has this
        // enabled answers a q=1 (default) `Accept: text/markdown` with
        // `content-type: text/markdown` directly, skipping Defuddle
        // entirely (see the branch below) - a zone that doesn't just
        // answers its ordinary HTML at q=0.9, exactly as before.
        Accept: 'text/markdown, text/html;q=0.9',
      },
    },
    FETCH_TIMEOUT_MS,
    pin,
  );
  if (!response.ok) {
    throw new Error(
      `defuddle: HTTP ${response.status} ${response.statusText} fetching ${finalUrl}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  // Task 6: an open-access PDF has no HTML to run Defuddle over, but it's
  // still the same guarded fetch this tier just made - branch on it here
  // rather than adding a fourth top-level tier, so a PDF gets exactly the
  // same SSRF guard, redirect handling, and size cap as everything else.
  // Checked by content-type first (the honest signal) and the URL's path
  // second (some OA hosts serve a PDF with a generic
  // application/octet-stream content-type but an honest .pdf path).
  const isPdf = contentType.includes('pdf') || /\.pdf(?:[?#]|$)/i.test(finalUrl);
  if (isPdf) {
    const bytes = await readCappedBytes(response, finalUrl, 'defuddle');
    const extracted = await extractPdfOffThread(bytes, finalUrl);
    return {
      url: finalUrl,
      title: extracted.title || finalUrl,
      text: extracted.text,
      via: 'pdf',
      pages: extracted.pages,
    };
  }
  // Task 13: the server answered the markdown hop - already agent-ready
  // text, no DOM to build and nothing for Defuddle to strip. Used as-is,
  // skipping extraction (and its worker hop) entirely.
  if (contentType.includes('text/markdown')) {
    const text = (await readCappedText(response, finalUrl, 'defuddle')).trim();
    return { url: finalUrl, title: finalUrl, text, via: 'markdown' };
  }
  if (!contentType.includes('html')) {
    throw new Error(
      `defuddle: response for ${finalUrl} is not HTML (content-type: ${contentType})`,
    );
  }
  const html = await readCappedText(response, finalUrl, 'defuddle');
  // Task 13: run off the main thread (see extract.ts) - Defuddle's DOM walk
  // over a large page is slow enough (seconds) to stall every concurrent
  // MCP request, including a plain /health check, if run inline here.
  const { title, text } = await extractHtml(html, finalUrl);
  if (text.length < MIN_TEXT_CHARS) return null; // too short, fall through
  return { url: finalUrl, title: title || finalUrl, text, via: 'defuddle' };
}

// --- Tier 2: jina reader -----------------------------------------------------

// r.jina.ai's plain-text response is a short metadata header followed by a
// "Markdown Content:" marker and the extracted body. Falls back to the raw
// response when the marker isn't present rather than dropping content.
function parseJinaPlainText(raw: string, url: string): FetchedPage {
  const titleMatch = raw.match(/^Title:\s*(.+)$/m);
  const markerIndex = raw.indexOf('Markdown Content:');
  const text =
    markerIndex >= 0 ? raw.slice(markerIndex + 'Markdown Content:'.length).trim() : raw.trim();
  return { url, title: titleMatch?.[1]?.trim() || url, text, via: 'jina' };
}

async function tryJinaReader(url: string): Promise<FetchedPage> {
  // Defense in depth: fetchAsText() already guards `url` before any tier
  // runs, but this tier delegates the actual fetch to a third party
  // (r.jina.ai), so the target is re-validated here too rather than
  // trusting that every future call site remembers to check first.
  await assertFetchableUrl(url);
  const key = config.JINA_API_KEY;
  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetchWithRetry(`https://r.jina.ai/${url}`, { headers }, FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`jina: HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }
  const raw = await readCappedText(response, url, 'jina');
  const page = parseJinaPlainText(raw, url);
  if (!page.text) throw new Error(`jina: empty reader response for ${url}`);
  return page;
}

// --- Tier 3: crawl4ai --------------------------------------------------------

interface Crawl4aiMarkdown {
  fit_markdown?: string;
  raw_markdown?: string;
}
interface Crawl4aiResult {
  success?: boolean;
  markdown?: string | Crawl4aiMarkdown;
  metadata?: { title?: string };
}
interface Crawl4aiResponse {
  results?: Crawl4aiResult[];
}

async function tryCrawl4ai(url: string): Promise<FetchedPage> {
  // Defense in depth (see tryJinaReader): crawl4ai runs inside Cave's own
  // network, so a private target reaching it is a real internal-network
  // exposure, not just a wasted call.
  await assertFetchableUrl(url);
  const base = config.CRAWL4AI_URL;
  if (!base) throw new Error('crawl4ai: CRAWL4AI_URL is not set');
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = config.CRAWL4AI_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const crawlUrl = `${base.replace(/\/$/, '')}/crawl`;
  // This server's own outbound call, so it is checked against the
  // configured origins rather than the private-range rules.
  assertConfiguredServiceUrl(crawlUrl);
  const response = await fetchWithRetry(
    crawlUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        urls: [url],
        crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'BYPASS' } },
      }),
    },
    FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`crawl4ai: HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }
  // fetchJSON() calls response.json() directly with no size cap; this tier
  // reads through the same capped path as the other two instead.
  const raw = await readCappedText(response, crawlUrl, 'crawl4ai');
  const data = JSON.parse(raw) as Crawl4aiResponse;
  const result = data.results?.[0];
  if (!result || result.success === false) {
    throw new Error(`crawl4ai: failed to render ${url}`);
  }
  const md = result.markdown;
  const text = (typeof md === 'string' ? md : (md?.fit_markdown ?? md?.raw_markdown ?? '')).trim();
  if (!text) throw new Error(`crawl4ai: no markdown content for ${url}`);
  return { url, title: result.metadata?.title || url, text, via: 'crawl4ai' };
}

// --- Chain -------------------------------------------------------------------

export async function fetchAsText(url: string): Promise<FetchedPage> {
  // One resolveFetchTarget() call up front, shared by all four tiers (they
  // all start from the same URL): it validates AND, for tier 1, hands
  // tryDefuddle the pin for the connection it is about to make - a second,
  // separate call here just to re-derive that pin would reopen the TOCTOU
  // gap resolveFetchTarget's own comment describes.
  const { pin } = await resolveFetchTarget(url);

  let lastError: Error = new Error(`fetchAsText: no tier was able to fetch ${url}`);

  try {
    const page = await tryDefuddle(url, pin);
    if (page) return page;
    lastError = new Error(`defuddle: extracted under ${MIN_TEXT_CHARS} chars for ${url}`);
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  if (config.JINA_API_KEY || config.ALEXANDRIA_JINA_READER === '1') {
    try {
      return await tryJinaReader(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (config.CRAWL4AI_URL) {
    try {
      return await tryCrawl4ai(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_BROWSER_RUN_TOKEN) {
    try {
      return await tryBrowserRun(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}
