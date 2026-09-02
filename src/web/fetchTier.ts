// fetchAsText(): the shared web-fetch chain behind the `webfetch` source and
// full-text reads for RSS-kind sources (rss.ts, googlenews.ts). Three tiers,
// tried in order, first one over the success threshold wins:
//
//   1. defuddle  - GET the page directly with a browser UA and run Defuddle
//                  (via linkedom's DOM) locally. No third-party dependency,
//                  works for any page this process can reach.
//   2. jina      - GET https://r.jina.ai/{url}, a hosted reader that renders
//                  JS and strips boilerplate server-side. Only tried when
//                  JINA_API_KEY or ALEXANDRIA_JINA_READER=1 is set, so an
//                  anonymous caller never eats into Jina's 20 RPM shared cap.
//   3. crawl4ai  - POST {CRAWL4AI_URL}/crawl, a self-hosted headless-browser
//                  render (see cave-infra). Only tried when CRAWL4AI_URL is
//                  configured.
//
// Tier 1 falls through to tier 2/3 when the page isn't HTML, when Defuddle
// can't extract at least MIN_TEXT_CHARS of text (a paywall stub, a JS-only
// shell, a login wall), or when the fetch itself fails. Tiers 2 and 3 are
// tried in order for as long as they're configured; fetchAsText throws the
// last tier's error once every configured tier has failed.
import { parseHTML } from 'linkedom';
import { fetchJSON, fetchWithRetry } from '../utils/http.js';

// defuddle/node only declares an ESM "import" condition (no "require"), and
// this package compiles to CommonJS (no "type": "module" in package.json,
// matching the rest of the repo's tsc/NodeNext setup); a static import would
// resolve through require() and fail with ERR_PACKAGE_PATH_NOT_EXPORTED.
// Node's dynamic import() always goes through the ESM resolver regardless of
// the importing module's own format, so it works from CommonJS. Cached after
// the first call so every tryDefuddle() call after the first is synchronous.
let defuddlePromise: Promise<typeof import('defuddle/node').Defuddle> | undefined;
function loadDefuddle(): Promise<typeof import('defuddle/node').Defuddle> {
  if (!defuddlePromise) {
    defuddlePromise = import('defuddle/node').then((mod) => mod.Defuddle);
  }
  return defuddlePromise;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  via: 'defuddle' | 'jina' | 'crawl4ai';
}

const FETCH_TIMEOUT_MS = 15_000;
const MIN_TEXT_CHARS = 500;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Hostnames whose ranges are always refused, with no override: RFC 1918
// private space, link-local, and the .internal/.local TLDs some homelabs use
// for their own services. Distinct from the loopback set below, which the
// test suite needs to be able to open up.
function isPrivateRangeHost(hostname: string): boolean {
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return false;
  const [a, b] = octets.map(Number);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  return false;
}

// localhost / 127.0.0.0/8 / ::1. Refused by default, but the unit test suite
// runs its fixture server on 127.0.0.1 and needs to reach it; set
// ALEXANDRIA_ALLOW_LOOPBACK=1 (the test setup does this) to allow it.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((o) => /^\d{1,3}$/.test(o));
}

// The hostnames of CRAWL4AI_URL/SEARXNG_URL: known service endpoints this
// server is configured to talk to, not a user-supplied fetch target, so they
// are exempt from the private-network guard below even when (as on this
// deployment) they resolve to a tailnet address.
function configuredServiceHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const envVar of ['CRAWL4AI_URL', 'SEARXNG_URL']) {
    const value = process.env[envVar];
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // Malformed env value; nothing to allow-list.
    }
  }
  return hosts;
}

// SSRF guard: fetchAsText's whole job is to fetch a caller-supplied URL, so
// this runs before any tier is attempted. Throws with a message that names
// the reason, never fetches.
export function assertFetchableUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`fetchAsText: not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`fetchAsText: refusing to fetch a non-http(s) URL: ${rawUrl}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (configuredServiceHosts().has(hostname)) return;
  if (isLoopbackHost(hostname)) {
    if (process.env.ALEXANDRIA_ALLOW_LOOPBACK === '1') return;
    throw new Error(`fetchAsText: refusing to fetch a loopback host: ${rawUrl}`);
  }
  if (isPrivateRangeHost(hostname)) {
    throw new Error(`fetchAsText: refusing to fetch a private-network host: ${rawUrl}`);
  }
}

// --- Tier 1: defuddle ------------------------------------------------------

async function tryDefuddle(url: string): Promise<FetchedPage | null> {
  const response = await fetchWithRetry(
    url,
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' } },
    FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`defuddle: HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html')) {
    throw new Error(`defuddle: response for ${url} is not HTML (content-type: ${contentType})`);
  }
  const html = await response.text();
  const { document } = parseHTML(html);
  const Defuddle = await loadDefuddle();
  const result = await Defuddle(document, url, { markdown: true });
  const text = (result.content ?? '').trim();
  if (text.length < MIN_TEXT_CHARS) return null; // too short, fall through
  return { url, title: result.title || url, text, via: 'defuddle' };
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
  const key = process.env.JINA_API_KEY;
  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetchWithRetry(`https://r.jina.ai/${url}`, { headers }, FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`jina: HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }
  const raw = await response.text();
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
  const base = process.env.CRAWL4AI_URL;
  if (!base) throw new Error('crawl4ai: CRAWL4AI_URL is not set');
  const headers: Record<string, string> = {};
  const token = process.env.CRAWL4AI_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await fetchJSON<Crawl4aiResponse>(
    `${base.replace(/\/$/, '')}/crawl`,
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
  assertFetchableUrl(url);

  let lastError: Error = new Error(`fetchAsText: no tier was able to fetch ${url}`);

  try {
    const page = await tryDefuddle(url);
    if (page) return page;
    lastError = new Error(`defuddle: extracted under ${MIN_TEXT_CHARS} chars for ${url}`);
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  if (process.env.JINA_API_KEY || process.env.ALEXANDRIA_JINA_READER === '1') {
    try {
      return await tryJinaReader(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (process.env.CRAWL4AI_URL) {
    try {
      return await tryCrawl4ai(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}
