// The one outbound User-Agent this server identifies itself with.
//
// Final wave (F1): there were three. fetchTier.ts's browserUA() was the
// honest one (task 13 replaced a Chrome-131 impersonation with
// `Alexandria/<version>`, overridable by ALEXANDRIA_FETCH_UA);
// utils/http.ts - the path every REST adapter actually takes - still sent
// `library-mcp-server/1.0 (open source research tool)`, a name this
// project has not used since it was renamed and a version that was never
// true; and wikipedia.ts/wikidata.ts hardcoded `alexandria-mcp/10`, frozen
// at the major this repo happened to be on when they were written. An
// operator reading their own server logs, or a source operator deciding
// whether to rate-limit this caller, saw three different callers.
//
// One builder, read fresh on every call (never memoized): config.ts's
// accessor is always-fresh by design, and VERSION comes from package.json,
// so a test that sets ALEXANDRIA_FETCH_UA sees it take effect.
//
// Overridable per deployment, not just per adapter: some operators may
// prefer a fully custom string (their own contact UA, or a browser UA if
// their traffic mix needs it) without patching source. A site that blocks
// unknown bots may block this string - see docs/fetch-tier-runtime.md for
// the before/after probe diff and any adapter that needed its old UA kept
// through a `headers` override to avoid a real regression.
import { config } from '../config.ts';
import { VERSION } from '../version.ts';

export function fetchUserAgent(): string {
  return (
    config.ALEXANDRIA_FETCH_UA ||
    `Alexandria/${VERSION} (+https://github.com/The-40-Thieves/alexandria-mcp)`
  );
}

// Four adapters are asked by their upstreams to carry a contact address:
// Wikimedia's User-Agent policy (wikipedia.ts, wikidata.ts), CISA's KEV
// feed (kev.ts), and ecosyste.ms, which answers 402 without a mailto
// (ecosystems.ts). CONTACT_EMAIL is folded in when set, and the repo URL
// stands in when it is not - all four used to hardcode `alexandria-mcp/10`,
// frozen at whatever major this repo was on when each was written.
export function contactUserAgent(): string {
  const email = process.env.CONTACT_EMAIL;
  const contact = email ? `mailto:${email}` : '+https://github.com/The-40-Thieves/alexandria-mcp';
  return `Alexandria/${VERSION} (${contact})`;
}
