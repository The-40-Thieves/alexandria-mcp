/**
 * Natural language library search router (v2, THE-319/320).
 *
 * Two stages:
 *   1. candidates() (src/utils/catalogIndex.ts) narrows the full registry
 *      down to the 20 most relevant sources, embedding-first with a BM25
 *      fallback, biased toward realtime/daily sources when the query reads
 *      as time-sensitive.
 *   2. An LLM (the `router` provider role) sees only those 20, tagged with
 *      cluster and freshness, picks at most max_sources, and writes an
 *      optimized per-source query. Fan-out and dedupe are unchanged from v1.
 */

import { z } from 'zod';
import { getAdapter } from '../sources/registry.js';
import type { LibraryResult } from '../types.js';
import { type CatalogEntry, candidates } from '../utils/catalogIndex.js';
import { chatJSON } from '../utils/providers.js';

export interface RouteItem {
  source: string;
  query: string;
  reason: string;
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
}

// Stage 1 + stage 2 only: no fan-out. Exported so callers that only need
// routing quality (scripts/eval-routing.ts's stage-1+2 scoring) don't have
// to pay for a live search against every selected source just to see which
// sources the router picked.
export async function planRoute(query: string, opts: AskOptions = {}): Promise<PlannedRoute> {
  const maxSources = opts.maxSources ?? 5;

  const freshness = detectFreshnessPreference(query);
  const pool = await candidates(query, CANDIDATE_POOL_SIZE, { freshness });

  const decision = await selectRoutes(query, pool, maxSources);
  const clusterBySource = new Map(pool.map((c) => [c.name, c.cluster]));

  // Only keep routes whose source names actually appear in the shortlist
  // the model was given; a hallucinated or out-of-shortlist name is dropped
  // rather than trusted.
  const validRoutes = decision.routes
    .slice(0, maxSources)
    .filter((r) => clusterBySource.has(r.source));

  return { intent: decision.intent, routes: validRoutes, clusterBySource };
}

// Stage 1 + stage 2 + fan-out, without the flattened/deduped shape the
// library_ask tool returns. Stage 9's library_answer/library_research call
// this directly to get per-source results before fusion.
export async function runAsk(query: string, opts: AskOptions = {}): Promise<RunAskResult> {
  const resultsPerSource = opts.resultsPerSource ?? 5;
  const { intent, routes: validRoutes, clusterBySource } = await planRoute(query, opts);

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

  return { intent, routing: validRoutes, perSource, errors };
}

export async function libraryAsk(
  query: string,
  maxSources = 5,
  resultsPerSource = 5,
): Promise<AskResult> {
  const { intent, routing, perSource, errors } = await runAsk(query, {
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
  };
}
