// The SSRF guard: everything that decides whether a URL may be fetched at
// all, and (for an ordinary hostname) which address the connection must be
// pinned to.
//
// Final wave (C2): lifted out of fetchTier.ts unchanged so
// src/utils/http.ts can apply the SAME guard to every hop of fetchJSON /
// fetchText, which every REST adapter goes through. fetchTier.ts imports
// utils/http.ts for fetchWithRetry, so utils/http.ts cannot import
// fetchTier.ts back; this module depends on config.ts and (type-only) the
// dispatcher's AddressPin, and on nothing that reaches back into either
// caller. fetchTier.ts re-exports every name below, so its existing
// importers are unchanged.
import { lookup as nodeDnsLookup } from 'node:dns/promises';
import { config } from '../config.ts';
import type { AddressPin } from '../utils/dispatcher.ts';

// Shared by every manual-redirect loop in this repo (fetchTier.ts's tier 1,
// utils/http.ts's fetchJSON/fetchText, utils/liveness.ts's probes) so the
// three cannot drift apart on which statuses count as a redirect or how
// many hops are too many. `redirect: 'manual'` plus a bounded loop is what
// puts the SSRF guard on every hop instead of only the caller's URL.
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 5;

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
// Called once up front in fetchAsText() (covering all four tiers, since
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

// Exported so a caller that needs to make its OWN guarded fetch (rather
// than going through fetchAsText's tier chain) can get the same pin
// fetchFollowingRedirects uses, instead of re-deriving it with a second,
// independent lookup (which would reopen the TOCTOU gap this function's
// own comment describes) or duplicating this guard's logic. See
// scripts/eval-answer.ts's checkResolvable for the first such caller: a
// guarded fetch through guardedDispatcher with no pin in scope fails
// closed (dispatcher.ts's pinnedLookup), so a caller-supplied hostname
// target must be wrapped in withPinnedAddress(pin, ...) using the pin this
// returns, exactly like fetchFollowingRedirects does below.
export async function resolveFetchTarget(rawUrl: string): Promise<ResolvedFetchTarget> {
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
