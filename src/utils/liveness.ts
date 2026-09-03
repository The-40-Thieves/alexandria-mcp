// Task 9: citation liveness for library_answer/library_research
// (Citation.resolves, declared by Task 1 in src/index.ts's outputSchema).
//
// Shares the guarded-and-pinned fetch approach scripts/eval-answer.ts's
// checkResolvable() worked out (task 8's fix round): a guarded HEAD,
// falling back to a GET when HEAD isn't ok, through guardedDispatcher, with
// the SAME address resolveFetchTarget() (src/web/fetchTier.ts) just
// validated pinned via withPinnedAddress() for both attempts - otherwise
// guardedDispatcher's connect.lookup fails closed with no pin in scope for
// an ordinary hostname target (dispatcher.ts's pinnedLookup). Moved here
// (rather than left duplicated in the eval script) so both the runtime
// answer path and the eval harness share one implementation; eval-answer.ts
// now imports checkUrlLiveness instead of keeping its own copy.

import { resolveFetchTarget } from '../web/fetchTier.ts';
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

// One URL's liveness, no caching - the primitive both checkLiveness() below
// and scripts/eval-answer.ts's checkResolvable() call.
export async function checkUrlLiveness(url: string): Promise<LivenessResult> {
  let pin: Awaited<ReturnType<typeof resolveFetchTarget>>['pin'];
  try {
    ({ pin } = await resolveFetchTarget(url));
  } catch {
    return { ok: false };
  }
  const withPin = <T>(fn: () => Promise<T>): Promise<T> =>
    pin ? withPinnedAddress(pin, fn) : fn();

  // retries: 0 on both attempts - this is a liveness probe, not a content
  // fetch, so one failed attempt per method is enough to call a target
  // unresolvable rather than spending fetchWithRetry's default retry
  // budget on it.
  try {
    const head = await withPin(() =>
      fetchWithRetry(url, { method: 'HEAD', dispatcher: guardedDispatcher }, RESOLVE_TIMEOUT_MS, 0),
    );
    if (head.ok) return { ok: true, status: head.status };
  } catch {
    // fall through to GET - some servers 405/501 HEAD or lie about it
  }
  try {
    const get = await withPin(() =>
      fetchWithRetry(url, { method: 'GET', dispatcher: guardedDispatcher }, RESOLVE_TIMEOUT_MS, 0),
    );
    return { ok: get.ok, status: get.status };
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
