// Task 9: citation liveness for library_answer/library_research
// (Citation.resolves, declared by Task 1 in src/index.ts's outputSchema).
//
// Shares the guarded-and-pinned fetch approach scripts/eval-answer.ts's
// checkResolvable() worked out (task 8's fix round): a guarded HEAD,
// falling back to a GET when HEAD isn't ok, through guardedDispatcher, with
// the SAME address resolveFetchTarget() (src/web/urlGuard.ts) just
// validated pinned via withPinnedAddress() for both attempts - otherwise
// guardedDispatcher's connect.lookup fails closed with no pin in scope for
// an ordinary hostname target (dispatcher.ts's pinnedLookup). Moved here
// (rather than left duplicated in the eval script) so both the runtime
// answer path and the eval harness share one implementation; eval-answer.ts
// now imports checkUrlLiveness instead of keeping its own copy.

import { MAX_REDIRECTS, REDIRECT_STATUSES, resolveFetchTarget } from '../web/urlGuard.ts';
import { guardedDispatcher, withPinnedAddress } from './dispatcher.ts';
import { fetchWithRetry } from './http.ts';
import { stateStore } from './stateStore.ts';

const RESOLVE_TIMEOUT_MS = 5_000;
// Matches the brief's "at most 20 URLs per answer" - a defensive ceiling on
// how many liveness checks one checkLiveness() call will actually make, not
// merely a documentation note. Citations well past this count are left out
// of the returned Map entirely (a caller reading .get(url) for one of them
// gets undefined, i.e. "not checked", same as an unrecognized url).
export const MAX_LIVENESS_CHECKS = 20;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'live|';

export interface LivenessResult {
  ok: boolean;
  status?: number;
}

// One probe (HEAD or GET), following redirects itself.
//
// Final wave (C1): both probes used to hand `fetch` its
// follow-redirects-automatically default, so a public, allowed URL that
// answered `Location: http://0.0.0.0:<port>/` or a cloud metadata address
// was followed with no guard on the destination - and a literal-IP hop
// skips guardedDispatcher's DNS hook entirely, so nothing downstream
// caught it either (reproduced against a localhost probe, which reported
// status 200 for the private target). Every hop now re-runs
// resolveFetchTarget() and pins the connection to the address that call
// just validated, exactly as fetchTier.ts's fetchFollowingRedirects does.
//
// The response body is always cancelled before returning, on the redirect
// hops and on the final response alike: fetchWithRetry clears its
// per-attempt timer the moment response headers arrive, so a server that
// streams a body forever would otherwise hold a socket open indefinitely
// with nothing left to time it out. Nothing here ever needs the body.
//
// `deadlineAt` bounds the WHOLE chain, not each hop: five hops each given
// the full RESOLVE_TIMEOUT_MS would be a 25 second liveness probe. Each
// probe method gets its own deadline (the same per-method budget this had
// before), so a slow HEAD cannot consume the GET fallback's.
async function probeFollowingRedirects(
  url: string,
  method: 'HEAD' | 'GET',
  deadlineAt: number,
): Promise<LivenessResult> {
  let currentUrl = url;
  let { pin } = await resolveFetchTarget(currentUrl);

  for (let hop = 0; ; hop++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error(`liveness: deadline exceeded probing ${url}`);
    const currentPin = pin;
    const withPin = <T>(fn: () => Promise<T>): Promise<T> =>
      currentPin ? withPinnedAddress(currentPin, fn) : fn();
    // retries: 0 - this is a liveness probe, not a content fetch, so one
    // failed attempt per method is enough to call a target unresolvable
    // rather than spending fetchWithRetry's default retry budget on it.
    const response = await withPin(() =>
      fetchWithRetry(
        currentUrl,
        { method, redirect: 'manual', dispatcher: guardedDispatcher },
        remainingMs,
        0,
      ),
    );
    await response.body?.cancel().catch(() => {});
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ok: response.ok, status: response.status };
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`liveness: more than ${MAX_REDIRECTS} redirects starting from ${url}`);
    }
    const location = response.headers.get('location');
    if (!location) throw new Error(`liveness: redirect from ${currentUrl} had no Location header`);
    const nextUrl = new URL(location, currentUrl).toString();
    // Throws for a private/loopback/non-http(s) destination, which is what
    // turns a redirect into a private address into "not resolvable"
    // (checkUrlLiveness's catch below) rather than a followed request.
    ({ pin } = await resolveFetchTarget(nextUrl));
    currentUrl = nextUrl;
  }
}

// One URL's liveness, no caching - the primitive both checkLiveness() below
// and scripts/eval-answer.ts's checkResolvable() call.
export async function checkUrlLiveness(url: string): Promise<LivenessResult> {
  try {
    const head = await probeFollowingRedirects(url, 'HEAD', Date.now() + RESOLVE_TIMEOUT_MS);
    if (head.ok) return head;
  } catch {
    // fall through to GET - some servers 405/501 HEAD or lie about it
  }
  try {
    return await probeFollowingRedirects(url, 'GET', Date.now() + RESOLVE_TIMEOUT_MS);
  } catch {
    return { ok: false };
  }
}

// Batched, deduped, capped at MAX_LIVENESS_CHECKS, and cached in the state
// store for 24h under `live|<url>` so a repeated answer citing the same
// URL (a popular source, a re-asked question) doesn't re-probe it on every
// call. A cache hit is checked before the MAX_LIVENESS_CHECKS cap is
// applied to the remaining, uncached URLs, so a fully-cached batch larger
// than the cap still resolves every entry from cache.
export async function checkLiveness(urls: string[]): Promise<Map<string, LivenessResult>> {
  const results = new Map<string, LivenessResult>();
  const now = Date.now();
  const uncached: string[] = [];

  for (const url of new Set(urls)) {
    const cached = stateStore.getCache<LivenessResult>(CACHE_KEY_PREFIX + url, now);
    if (cached) results.set(url, cached);
    else uncached.push(url);
  }

  const toCheck = uncached.slice(0, MAX_LIVENESS_CHECKS);
  await Promise.all(
    toCheck.map(async (url) => {
      const result = await checkUrlLiveness(url);
      results.set(url, result);
      stateStore.setCache(CACHE_KEY_PREFIX + url, result, now + CACHE_TTL_MS, now);
    }),
  );

  return results;
}
