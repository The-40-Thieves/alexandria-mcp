/**
 * Natural language library search router (v2, THE-319/320).
 *
 * Two stages:
 *   1. candidatesWithMargin() (src/utils/catalogIndex.ts) narrows the full
 *      registry down to the 20 most relevant sources, embedding-first with
 *      a BM25 fallback, biased toward realtime/daily sources when the
 *      query reads as time-sensitive. It also reports a confidence margin:
 *      how much better the top candidate scored than the one at position
 *      max_sources+1.
 *   2. An LLM (the `router` provider role) sees only those 20, tagged with
 *      cluster and freshness, picks at most max_sources, and writes an
 *      optimized per-source query. Fan-out and dedupe are unchanged from v1.
 *
 * Task 6 (review 3.5): stage 2 is skipped - no LLM call at all - when
 * stage 1's margin is confident enough (>= config.ALEXANDRIA_ROUTER_SKIP_MARGIN),
 * fanning out to stage 1's own top max_sources with the raw query instead.
 * The full routing decision (from either path) is also cached by normalised
 * query + max_sources for the result cache TTL, so a repeated query costs
 * no LLM call regardless of the margin.
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { getAdapter } from '../sources/registry.ts';
import type { LibraryResult } from '../types.ts';
import { type CatalogEntry, candidatesWithMargin, type Stage1Mode } from '../utils/catalogIndex.ts';
import { chatJSON } from '../utils/providers.ts';
import { routingCache, routingCacheKey } from '../utils/resultCache.ts';

export interface RouteItem {
  source: string;
  query: string;
  reason: string;
}

export type Stage2Mode = 'llm' | 'skipped';

// Chosen from the eval matrix recorded in docs/routing-eval.md: the largest
// of the three margins tested (0.2/0.3/0.4) whose stage-1+2 nDCG@5, with
// embeddings configured (the better of the two stage-1 modes measured),
// stayed within 0.01 of always calling the router.
const DEFAULT_ROUTER_SKIP_MARGIN = 0.4;

// See config.ts's ALEXANDRIA_ROUTER_SKIP_MARGIN and docs/routing-eval.md for
// how the default was chosen. No upper-bound clamp: margin is normally
// 0-1, but cosine mode can score the position maxSources+1 candidate
// below zero (a real, dissimilar vector, unlike BM25's floor of 0), which
// pushes margin above 1 - so a deployer wanting to disable the skip
// entirely can set this above 1 (e.g. "2") and rely on margin never
// reaching it, rather than needing a separate off switch.
//
// Undefined, or present-but-empty/whitespace-only (the shape an env-file
// loader produces for a declared, unset var - config.ts's own preprocess
// already normalizes that away before this ever sees it, but this stays
// defensive against a direct caller that doesn't go through config.ts),
// is treated as "not configured" and falls back silently, no warning: an
// explicit "0" is a valid, deliberate opt-in to "always skip". Anything
// else that fails to parse as a finite, non-negative number (not a
// number, or negative) is a genuinely malformed value, not merely unset -
// falls back too, but with a one-time warning, the same "warn once, keep
// going" shape stateStore.ts's warnFallbackOnce and dispatcher.ts's
// warnFallbackOnce use.
let warnedInvalidSkipMargin = false;

function warnInvalidSkipMarginOnce(raw: string): void {
  if (warnedInvalidSkipMargin) return;
  warnedInvalidSkipMargin = true;
  log.warn(
    { ALEXANDRIA_ROUTER_SKIP_MARGIN: raw },
    'invalid ALEXANDRIA_ROUTER_SKIP_MARGIN (not a finite, non-negative number); falling back to the default',
  );
}

/** Test-only: clears the "already warned" latch so a test can observe the warning fire again. */
export function resetSkipMarginWarningForTests(): void {
  warnedInvalidSkipMargin = false;
}

export function parseSkipMargin(
  raw: string | undefined,
  fallback = DEFAULT_ROUTER_SKIP_MARGIN,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    warnInvalidSkipMarginOnce(raw);
    return fallback;
  }
  return n;
}

const RoutingDecisionSchema = z.object({
  intent: z.string().min(1),
  routes: z.array(
    z.object({
      source: z.string().min(1),
      query: z.string().min(1),
      reason: z.string().default(''),
    }),
  ),
});

type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export interface AskResult {
  query: string;
  intent: string;
  sources_searched: string[];
  total_results: number;
  results: LibraryResult[];
  routing: RouteItem[];
  errors: Array<{ source: string; error: string }>;
  // Which stage-1 ranker actually ran: 'embeddings' when the catalog was
  // embedded (cosine ranking), 'bm25' for the offline fallback. Determines
  // whether the router-skip margin applied at all by default - see
  // Stage1Mode's comment in catalogIndex.ts and the module comment above.
  stage1: Stage1Mode;
  // 'llm' when the router role picked the sources; 'skipped' when stage 1's
  // margin was confident enough that library_ask fanned out to its top
  // max_sources directly, with no router LLM call at all (see the module
  // comment above).
  stage2: Stage2Mode;
}

export interface AskOptions {
  maxSources?: number;
  resultsPerSource?: number;
}

export interface RunAskResult {
  intent: string;
  routing: RouteItem[];
  perSource: Record<string, LibraryResult[]>;
  errors: Array<{ source: string; error: string }>;
  stage1: Stage1Mode;
  stage2: Stage2Mode;
}

const CANDIDATE_POOL_SIZE = 20;

// A query that reads as time-sensitive prefers fresher sources at stage 1:
// an explicit "right now" term (latest/today/this week/breaking) prefers
// realtime; a bare mention of the current or previous year is a weaker
// signal and prefers daily.
export function detectFreshnessPreference(query: string): 'realtime' | 'daily' | undefined {
  const q = query.toLowerCase();
  if (['latest', 'today', 'this week', 'breaking'].some((term) => q.includes(term))) {
    return 'realtime';
  }
  const yearMatch = query.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const year = Number(yearMatch[0]);
    if (year >= new Date().getFullYear() - 1) return 'daily';
  }
  return undefined;
}

// "name: description (cluster X)" plus a freshness tag, so the stage-2
// prompt sees exactly what stage 1 used to narrow the field.
function formatCandidate(entry: CatalogEntry): string {
  return `${entry.text} [freshness: ${entry.freshness}]`;
}

function buildSystemPrompt(pool: CatalogEntry[], maxSources: number): string {
  const candidateList = pool.map(formatCandidate).join('\n');
  return `You are a library search router. Below is a shortlist of candidate sources, already narrowed from the full registry for this one query.
Select the most relevant sources from the shortlist and generate an optimized search string for each.

Return JSON with this exact structure:
{
  "intent": "one sentence describing what the user wants",
  "routes": [
    { "source": "exact_source_name", "query": "optimized search string", "reason": "brief reason" }
  ]
}

Rules:
- source must EXACTLY match one of the candidate source names below, not any other source you may know about
- Select at most ${maxSources} sources ordered by relevance
- Generate short, precise queries optimized for each source's search system
- For codewiki, the query should be an owner/repo like "tensorflow/tensorflow" or a project name
- For youtube, the query should be phrased like a natural YouTube search (video title keywords, not a research query)

Candidate sources (name: description (cluster) [freshness]):
${candidateList}`;
}

async function selectRoutes(
  query: string,
  pool: CatalogEntry[],
  maxSources: number,
): Promise<RoutingDecision> {
  const system = buildSystemPrompt(pool, maxSources);
  return chatJSON('router', system, query, RoutingDecisionSchema);
}

export interface PlannedRoute {
  intent: string;
  routes: RouteItem[];
  clusterBySource: Map<string, string>;
  stage1: Stage1Mode;
  stage2: Stage2Mode;
}

// Stage 1 + stage 2 only: no fan-out. Exported so callers that only need
// routing quality (scripts/eval-routing.ts's stage-1+2 scoring) don't have
// to pay for a live search against every selected source just to see which
// sources the router picked.
export async function planRoute(query: string, opts: AskOptions = {}): Promise<PlannedRoute> {
  const maxSources = opts.maxSources ?? 5;

  // A cache hit replays a previously computed decision (router or
  // margin-skip) verbatim - no stage 1 or stage 2 work at all, so no LLM
  // call of any kind, not even the query embed() cosine ranking needs.
  const key = routingCacheKey(query, maxSources);
  const cached = routingCache.get(key);
  if (cached) {
    return {
      intent: cached.intent,
      routes: cached.routes.map((r) => ({ source: r.source, query: r.query, reason: r.reason })),
      clusterBySource: new Map(cached.routes.map((r) => [r.source, r.cluster])),
      stage1: cached.stage1,
      stage2: cached.stage2,
    };
  }

  const freshness = detectFreshnessPreference(query);
  const {
    candidates: pool,
    margin,
    topCluster,
    stage1,
  } = await candidatesWithMargin(query, CANDIDATE_POOL_SIZE, maxSources, { freshness });
  log.debug(
    { query, maxSources, margin, topCluster, stage1 },
    'library_ask: stage-1 routing margin',
  );

  const clusterBySource = new Map(pool.map((c) => [c.name, c.cluster]));
  // Review 3.5 ruling (docs/routing-eval.md): the skip only applies by
  // default in embeddings mode - BM25's margin measured 0.024 nDCG@5 below
  // always-router at every tested threshold (outside the brief's 0.01
  // band), and its normalised scores run structurally higher (near-
  // saturated: 60/62 golden queries skipped at 0.2, 0.3, AND 0.4 alike),
  // so the *default* margin isn't a meaningful confidence signal there.
  // In BM25 mode the fallback passed to parseSkipMargin is +Infinity, not
  // DEFAULT_ROUTER_SKIP_MARGIN, so an unset or invalid
  // ALEXANDRIA_ROUTER_SKIP_MARGIN never skips (margin can't reach
  // Infinity); an operator who sets it explicitly and validly is opting
  // in deliberately, in either mode, exactly like any other value.
  const skipMargin = parseSkipMargin(
    config.ALEXANDRIA_ROUTER_SKIP_MARGIN,
    stage1 === 'embeddings' ? DEFAULT_ROUTER_SKIP_MARGIN : Number.POSITIVE_INFINITY,
  );

  let intent: string;
  let validRoutes: RouteItem[];
  let stage2: Stage2Mode;

  if (margin >= skipMargin) {
    // Confident enough stage 1 that the router LLM call isn't worth
    // making: fan out to stage 1's own top max_sources, with the raw
    // (unoptimized) query - selectRoutes()'s job is exactly to narrow and
    // optimize per-source queries, and this is skipping that job because
    // stage 1 already did the narrowing decisively.
    stage2 = 'skipped';
    intent = query;
    validRoutes = pool.slice(0, maxSources).map((c) => ({
      source: c.name,
      query,
      reason: `stage-1 (${stage1}) margin ${margin.toFixed(2)} >= skip margin ${skipMargin}`,
    }));
  } else {
    stage2 = 'llm';
    const decision = await selectRoutes(query, pool, maxSources);
    intent = decision.intent;
    // Only keep routes whose source names actually appear in the shortlist
    // the model was given; a hallucinated or out-of-shortlist name is
    // dropped rather than trusted.
    validRoutes = decision.routes.slice(0, maxSources).filter((r) => clusterBySource.has(r.source));
  }

  routingCache.set(key, {
    intent,
    stage1,
    stage2,
    routes: validRoutes.map((r) => ({ ...r, cluster: clusterBySource.get(r.source) ?? '' })),
  });

  return { intent, routes: validRoutes, clusterBySource, stage1, stage2 };
}

// Stage 1 + stage 2 + fan-out, without the flattened/deduped shape the
// library_ask tool returns. Stage 9's library_answer/library_research call
// this directly to get per-source results before fusion.
export async function runAsk(query: string, opts: AskOptions = {}): Promise<RunAskResult> {
  const resultsPerSource = opts.resultsPerSource ?? 5;
  const {
    intent,
    routes: validRoutes,
    clusterBySource,
    stage1,
    stage2,
  } = await planRoute(query, opts);

  const searches = validRoutes.map(async (route) => {
    try {
      const adapter = getAdapter(route.source);
      const results = await adapter.search(route.query, resultsPerSource);
      const cluster = clusterBySource.get(route.source);
      const tagged = cluster
        ? results.map((r) => ({ ...r, cluster: r.cluster ?? cluster }))
        : results;
      return { source: route.source, results: tagged, error: null as string | null };
    } catch (err) {
      return {
        source: route.source,
        results: [] as LibraryResult[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const settled = await Promise.allSettled(searches);
  const perSource: Record<string, LibraryResult[]> = {};
  const errors: Array<{ source: string; error: string }> = [];

  for (const r of settled) {
    if (r.status === 'fulfilled') {
      perSource[r.value.source] = r.value.results;
      if (r.value.error) errors.push({ source: r.value.source, error: r.value.error });
    } else {
      errors.push({
        source: 'unknown',
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  return { intent, routing: validRoutes, perSource, errors, stage1, stage2 };
}

export async function libraryAsk(
  query: string,
  maxSources = 5,
  resultsPerSource = 5,
): Promise<AskResult> {
  const { intent, routing, perSource, errors, stage1, stage2 } = await runAsk(query, {
    maxSources,
    resultsPerSource,
  });

  const allResults = Object.values(perSource).flat();

  // Deduplicate: normalize title to a short key
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    const key = r.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    query,
    intent,
    sources_searched: routing.map((r) => r.source),
    total_results: deduped.length,
    results: deduped,
    routing,
    errors,
    stage1,
    stage2,
  };
}
