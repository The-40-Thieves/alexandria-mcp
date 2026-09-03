// fetchAsText(): the shared web-fetch chain behind the `webfetch` source and
// full-text reads for RSS-kind sources (rss.ts, googlenews.ts). Three tiers,
// tried in order, first one over the success threshold wins:
//
//   1. defuddle  - GET the page directly with a browser UA and run Defuddle
//                  (via linkedom's DOM) locally. No third-party dependency,
//                  works for any page this process can reach. Follows
//                  redirects itself (redirect: 'manual' + a capped loop, see
//                  fetchFollowingRedirects) so every hop gets the SSRF guard,
//                  not just the URL the caller supplied. When the response
//                  is a PDF (by content-type or a .pdf URL path) this tier
//                  extracts it with unpdf (see pdf.ts) instead of running
//                  Defuddle, returning via: 'pdf' with per-page text.
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
//
// SECURITY: every tier is fetching (or asking a service to fetch, tiers 2/3)
// a URL the caller supplied — this whole module is an SSRF surface. See
// assertFetchableUrl() below for the guard, and its module comment for the
// one documented residual gap (TOCTOU on tiers 2/3).

import { lookup as nodeDnsLookup } from 'node:dns/promises';
import { parseHTML } from 'linkedom';
import { config } from '../config.ts';
import { type AddressPin, guardedDispatcher, withPinnedAddress } from '../utils/dispatcher.ts';
import { fetchWithRetry } from '../utils/http.ts';
import { extractPdf, type PdfPage } from './pdf.ts';

// Loaded dynamically rather than with a static import so it is only pulled
// in when tier 1 actually runs, not on every module load. Cached after the
// first call so every tryDefuddle() call after the first is synchronous.
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
  via: 'defuddle' | 'jina' | 'crawl4ai' | 'pdf';
  // Set only when via === 'pdf': one entry per PDF page, in order. `text`
  // above is these pages' text joined by pdf.ts's PDF_PAGE_JOINER - the
  // library_read handler (src/index.ts) walks that same join to turn this
  // into ReadResult.pages' charStart/charEnd.
  pages?: PdfPage[];
}

const FETCH_TIMEOUT_MS = 15_000;
const MIN_TEXT_CHARS = 500;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── SSRF guard ──────────────────────────────────────────────────────────────
//
// dns.lookup() is called through this mutable ref rather than the imported
// binding directly: ESM named imports are read-only bindings (you can't
// reassign `nodeDnsLookup` from a test, unlike globalThis.fetch elsewhere in
// this test suite, which is a plain mutable global), so tests that need to
// simulate "this hostname resolves to a private address" swap out
// dnsResolver.lookup instead. Narrowed to the one overload this module
// actually calls (hostname, { all: true }) rather than typeof nodeDnsLookup
// (dns.lookup's full overloaded signature), so a test mock is a plain async
// function with no awkward overload-matching cast.
export type DnsLookupAll = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;
export const dnsResolver: { lookup: DnsLookupAll } = { lookup: nodeDnsLookup };

type IpClass = 'loopback' | 'private' | null;

// IPv4 range classification. `a` in [127] is loopback (overridable via
// ALEXANDRIA_ALLOW_LOOPBACK); every other reserved/private/special range is
// always refused, no override:
//   0.0.0.0/8        "this network"
//   10.0.0.0/8       RFC 1918 private
//   100.64.0.0/10    carrier-grade NAT (RFC 6598) — includes cloud metadata
//                    proxies on some platforms
//   169.254.0.0/16   link-local — includes 169.254.169.254, the near-universal
//                    cloud instance-metadata address
//   172.16.0.0/12    RFC 1918 private
//   192.168.0.0/16   RFC 1918 private
//   224.0.0.0/4      multicast
//   240.0.0.0/4      reserved (includes 255.255.255.255 broadcast)
function classifyIpv4(a: number, b: number, c: number, d: number): IpClass {
  void c;
  void d;
  if (a === 127) return 'loopback';
  if (a === 0) return 'private';
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 169 && b === 254) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a >= 224 && a <= 239) return 'private';
  if (a >= 240) return 'private';
  return null;
}

// Dotted-decimal IPv4 only (a.b.c.d, each octet 0-255). The WHATWG URL
// parser already normalizes every other IPv4 literal shorthand (a bare
// decimal integer like `2130706433`, octal octets like `0177.0.0.1`, the
// 2/3-part shorthand like `127.1`) into this canonical form before this
// code ever sees `parsed.hostname` — verified live against Node's URL
// implementation — so there's no separate literal parser to maintain here.
function parseDottedIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

// The last two ':'-groups of an IPv4-mapped (::ffff:a.b.c.d) or NAT64
// (64:ff9b::/96) IPv6 address encode the embedded IPv4 address. Node's URL
// parser (and dns.lookup) present these in hex-group form even when the
// input was written with a dotted tail (`::ffff:127.0.0.1` becomes
// `::ffff:7f00:1`), so this converts either representation.
function ipv4FromHexGroups(hi: string, lo: string): [number, number, number, number] | null {
  const h = Number.parseInt(hi, 16);
  const l = Number.parseInt(lo, 16);
  if (!Number.isFinite(h) || !Number.isFinite(l) || h > 0xffff || l > 0xffff) return null;
  return [(h >> 8) & 0xff, h & 0xff, (l >> 8) & 0xff, l & 0xff];
}

// IPv6 classification: ::1 loopback, :: (unspecified), fe80::/10 link-local,
// fc00::/7 unique-local (ULA), plus IPv4-mapped and NAT64 addresses
// unwrapped and classified as their embedded IPv4 address.
function classifyIpv6(host: string): IpClass {
  const h = host.toLowerCase();
  if (h === '::1') return 'loopback';
  if (h === '::') return 'private'; // unspecified address
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'private'; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'private'; // fc00::/7

  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const v4 = ipv4FromHexGroups(mappedHex[1], mappedHex[2]);
    return v4 ? classifyIpv4(...v4) : null;
  }
  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    const v4 = parseDottedIPv4(mappedDotted[1]);
    return v4 ? classifyIpv4(...v4) : null;
  }
  const nat64 = h.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64) {
    const v4 = ipv4FromHexGroups(nat64[1], nat64[2]);
    return v4 ? classifyIpv4(...v4) : null;
  }
  return null;
}

// Classifies a bracket-free host string that is ALREADY a literal IPv4 or
// IPv6 address (not a hostname to resolve). Returns null both for an
// ordinary hostname (not a literal IP at all) AND for a literal IP that
// isn't in any restricted range (a genuine public address) - callers that
// need to tell those two null cases apart (is this string a literal IP at
// all, regardless of whether it's restricted) must check isIpLiteral()
// first; see its comment for the bug that conflating them caused.
function classifyIpLiteral(host: string): IpClass {
  const v4 = parseDottedIPv4(host);
  if (v4) return classifyIpv4(...v4);
  if (host.includes(':')) return classifyIpv6(host);
  return null;
}

// Final wave, A12: resolveFetchTarget() used to gate its "skip DNS
// resolution, nothing to pin" early return on `classifyIpLiteral(host)`
// being truthy - which only holds for a RESTRICTED literal (loopback,
// private, link-local, ...), not for a literal IP at all. A public IPv6
// literal (https://[2606:4700:4700::1111]/, Cloudflare's actual address)
// classifies as null (it isn't restricted) and fell through to
// dnsResolver.lookup(parsed.hostname, ...) with the host still bracketed -
// Node's dns.lookup() can't resolve a bracket-wrapped literal, so this
// failed with ENOTFOUND on every public IPv6 literal target. Whether a
// string is a literal IP at all (skip DNS either way) is a different
// question from whether that address is restricted (throw or allow) -
// this answers the first one.
function isIpLiteral(host: string): boolean {
  return parseDottedIPv4(host) !== null || host.includes(':');
}

function throwForIpClass(cls: Exclude<IpClass, null>, rawUrl: string, detail?: string): never {
  const suffix = detail ? ` (${detail})` : '';
  if (cls === 'loopback') {
    throw new Error(`fetchAsText: refusing to fetch a loopback host: ${rawUrl}${suffix}`);
  }
  throw new Error(`fetchAsText: refusing to fetch a private-network host: ${rawUrl}${suffix}`);
}

// Refused unless ALEXANDRIA_ALLOW_LOOPBACK=1: 127.0.0.1 is the fixture server
// the unit test suite runs its fetch tier tests against.
function assertIpClassAllowed(cls: IpClass, rawUrl: string, detail?: string): void {
  if (!cls) return;
  if (cls === 'loopback' && config.ALEXANDRIA_ALLOW_LOOPBACK === '1') return;
  throwForIpClass(cls, rawUrl, detail);
}

// The full origins (scheme + host + port) of CRAWL4AI_URL/SEARXNG_URL: the
// service endpoints this server is configured to call itself.
//
// Matching on origin rather than hostname is the point. These services run
// on tailnet/private addresses, so a hostname-only allowlist let any
// caller-supplied URL naming that host through the private-network guard,
// on ANY port and ANY scheme, turning the webfetch source into an internal
// port scanner for the box crawl4ai and SearXNG run on.
export function configuredServiceOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of [config.CRAWL4AI_URL, config.SEARXNG_URL]) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin.toLowerCase());
    } catch {
      // Malformed env value; nothing to allow-list.
    }
  }
  return origins;
}

// Guard for THIS server's own outbound call to a configured service
// endpoint, which is the only case the allowlist covers. A user-supplied
// fetch target is never checked against it: assertFetchableUrl() applies
// the private-range rules to every target, including one that names a
// service host, so pointing webfetch at http://<crawl4ai-host>:22/ is
// refused like any other private address.
export function assertConfiguredServiceUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`fetchAsText: not a valid service URL: ${rawUrl}`);
  }
  if (!configuredServiceOrigins().has(parsed.origin.toLowerCase())) {
    throw new Error(
      `fetchAsText: refusing to call a service endpoint outside the configured origins: ${rawUrl}`,
    );
  }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// SSRF guard: every tier is fetching (or delegating the fetch of) a
// caller-supplied URL, so this runs before any of them touch the target.
// Called once up front in fetchAsText() (covering all three tiers, since
// they all share the same starting URL) and again, defensively, at the top
// of tryJinaReader()/tryCrawl4ai() and on every redirect hop
// (fetchFollowingRedirects) — a private target must never reach a tier's
// delegate, however this function ends up being reached.
//
// Checks, in order: valid http(s) URL, no embedded credentials
// (user:pass@host), then .internal/.local
// and 'localhost' by string, then IP classification — directly for a
// literal IP host (skips DNS), or via dns.lookup(..., { all: true }) for an
// ordinary hostname, checking EVERY returned address (closes the gap where
// a hostname's *string* looks public but resolves to a private address —
// attacker-controlled DNS / DNS rebinding).
//
// TOCTOU: the address(es) validated here are not, on their own, what pins
// the actual TCP connection Node's fetch/undici makes a moment later, and
// a second DNS answer at connect time (rebinding between this check and the
// fetch) would not be caught by validation alone. resolveFetchTarget()
// below closes that gap for the one fetch that actually connects to a
// caller-supplied hostname (tier 1, via fetchFollowingRedirects): it reuses
// THIS SAME dns.lookup() call as the pin fetchFollowingRedirects then
// forces guardedDispatcher's connection to, via withPinnedAddress() (see
// dispatcher.ts): a second, independent lookup to build the pin would just
// reopen the race it exists to close. assertFetchableUrl() below is a thin
// wrapper that keeps the original validate-only signature for callers that
// only need the guard (e.g. src/sources/mcp/jina.ts, which never performs
// the fetch itself).
export interface ResolvedFetchTarget {
  // Set for every guarded, non-literal-IP target (an ordinary hostname, or
  // 'localhost'): every address that lookup validated, in the same order,
  // safe to pin the connection to - see guardedDispatcher's pinnedLookup in
  // dispatcher.ts for why the connection needs the WHOLE set (Happy
  // Eyeballs / connection failover within it), not just the first entry.
  pin?: AddressPin;
}

// 'localhost' is resolved locally (hosts file / the platform's own loopback
// mapping) rather than through dnsResolver.lookup - see the comment at its
// call site below for why - so its pin is these two well-known loopback
// literals rather than a live lookup result. Both are always valid
// addresses for 'localhost' on every platform this runs on; pinning both
// (instead of guessing one) lets Happy Eyeballs pick whichever family the
// target actually has a listener on.
const LOCALHOST_PIN_ADDRESSES: Array<{ address: string; family: number }> = [
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 },
];

async function resolveFetchTarget(rawUrl: string): Promise<ResolvedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`fetchAsText: not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`fetchAsText: refusing to fetch a non-http(s) URL: ${rawUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `fetchAsText: refusing to fetch a URL carrying embedded credentials: ${rawUrl}`,
    );
  }

  // No service-endpoint exemption here on purpose: see
  // assertConfiguredServiceUrl(). A caller-supplied target that happens to
  // name the crawl4ai or SearXNG host is still a caller-supplied target.
  const hostname = stripBrackets(parsed.hostname).toLowerCase();
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new Error(`fetchAsText: refusing to fetch a private-network host: ${rawUrl}`);
  }
  if (hostname === 'localhost') {
    assertIpClassAllowed('loopback', rawUrl);
    // Deliberately NOT resolved via dnsResolver.lookup, unlike an ordinary
    // hostname below: the allow/deny decision above already doesn't depend
    // on resolution, and guardedDispatcher still needs a pin for 'localhost'
    // (its connect.lookup hook runs for every hostname, this one included -
    // see dispatcher.ts) or every guarded fetch to 'localhost' would fail
    // closed with no pin in scope, which used to work before this task.
    return { pin: { hostname, addresses: LOCALHOST_PIN_ADDRESSES } };
  }

  if (isIpLiteral(hostname)) {
    // Allowed or restricted, a literal IP is never resolved: undici's
    // connector skips DNS/connect.lookup entirely for a literal IP target,
    // and Node's dns.lookup() can't resolve one anyway (see isIpLiteral's
    // comment for the bug this used to hit on a public IPv6 literal).
    assertIpClassAllowed(classifyIpLiteral(hostname), rawUrl);
    return {};
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    // `hostname` (stripBrackets + lowercased above), not `parsed.hostname`:
    // unified with the same spelling stored as pin.hostname below, and
    // with what dispatcher.ts's pinnedLookup compares against (final wave,
    // A12) - brackets never apply here (isIpLiteral already returned
    // false), so this only changes casing for an ordinary hostname, but
    // keeps both call sites reading from one normalized value instead of
    // two independently-derived ones that happen to usually agree.
    addresses = await dnsResolver.lookup(hostname, { all: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`fetchAsText: could not resolve ${hostname}: ${message}`);
  }
  for (const { address } of addresses) {
    const cls = classifyIpLiteral(address.toLowerCase());
    if (cls) assertIpClassAllowed(cls, rawUrl, `${hostname} resolves to ${address}`);
  }
  // Every address in `addresses` was individually checked above (refused
  // if any one of them is private/loopback-without-override), so the whole
  // set - not just the first entry - is safe to hand to guardedDispatcher
  // as the pin, preserving the failover across addresses the plain default
  // connector this dispatcher replaces already had.
  return addresses.length > 0 ? { pin: { hostname, addresses } } : {};
}

export async function assertFetchableUrl(rawUrl: string): Promise<void> {
  await resolveFetchTarget(rawUrl);
}

// ─── Response size cap ──────────────────────────────────────────────────────

// Rejects fast on an honest, oversized Content-Length; otherwise streams the
// body counting bytes and aborts once the running total passes the cap, so a
// server that lies about (or omits) Content-Length can't force this process
// to buffer an unbounded response. Shared by all three tiers (defuddle
// fetches directly; jina and crawl4ai delegate the fetch but the response
// still flows through this process), each tagging its own error messages
// with `label` so a cap failure reads the same way callers already expect
// (`/defuddle:/`, `/jina:/`, `/crawl4ai:/` in fetchAsText's error).
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

async function readCappedText(response: Response, url: string, label: string): Promise<string> {
  const bytes = await readCappedBytes(response, url, label);
  return new TextDecoder('utf-8').decode(bytes);
}

// ─── Redirect handling ──────────────────────────────────────────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' } },
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
    const extracted = await extractPdf(bytes, finalUrl);
    return {
      url: finalUrl,
      title: extracted.title || finalUrl,
      text: extracted.text,
      via: 'pdf',
      pages: extracted.pages,
    };
  }
  if (!contentType.includes('html')) {
    throw new Error(
      `defuddle: response for ${finalUrl} is not HTML (content-type: ${contentType})`,
    );
  }
  const html = await readCappedText(response, finalUrl, 'defuddle');
  const { document } = parseHTML(html);
  const Defuddle = await loadDefuddle();
  const result = await Defuddle(document, finalUrl, { markdown: true });
  const text = (result.content ?? '').trim();
  if (text.length < MIN_TEXT_CHARS) return null; // too short, fall through
  return { url: finalUrl, title: result.title || finalUrl, text, via: 'defuddle' };
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
  // One resolveFetchTarget() call up front, shared by all three tiers (they
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

  throw lastError;
}
