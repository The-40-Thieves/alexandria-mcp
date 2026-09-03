// `npm run eval:routing`: scores the two-stage router (src/tools/
// libraryAsk.ts, src/utils/catalogIndex.ts) against eval/routing-golden.yaml.
//
// Stage 1 alone (candidates()) is always scored, entirely offline: BM25
// when no embeddings role is configured, cosine otherwise. Stage 1+2 (the
// router LLM's actual source picks) is scored on top of that only when a
// router role is configured (roleConfig('router').apiKey is set) - it makes
// one real LLM call per golden query, so it's opt-in on cost, not a fixed
// part of every run.
//
// Fairness: a golden query's `expected` list can legitimately name a source
// that's currently `hidden` (needs an API key not set in this deployment).
// Scoring that source as a miss would penalize the ROUTER for a key this
// deployment simply doesn't have, not for a routing mistake. score() drops
// hidden expected sources before scoring (listSources() is the source of
// truth for what's hidden right now), counts how many it dropped, and
// excludes a query entirely (rather than scoring it against an empty
// expected set) when every one of its expected sources turns out hidden.
//
// Exit code: 1 only when embeddings ARE configured and stage-1 nDCG@5 is
// below the 0.60 floor, OR stage-1 recall@20 is below the 0.80 floor (stage
// 2 only ever sees stage 1's top 20 candidates, so recall@20 is the real
// ceiling on what stage 2 could possibly recover - a regression there is a
// stage-1 regression even if nDCG@5 hasn't dropped yet). Otherwise this only
// prints and exits 0, so a BM25-only run (no embeddings key at all, the
// common case for CI) never fails the gate on a ranking quality it can't yet
// improve.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import '../src/sources/all.ts';
import { listSources } from '../src/sources/registry.ts';
import { planRoute } from '../src/tools/libraryAsk.ts';
import { candidates } from '../src/utils/catalogIndex.ts';
import { installDispatcher } from '../src/utils/dispatcher.ts';
import { requestContext } from '../src/utils/http.ts';
import { resetMetricsForTests, toolMetrics } from '../src/utils/metrics.ts';
import { hasEmbeddingsConfigured, roleConfig } from '../src/utils/providers.ts';

export interface GoldenQuery {
  query: string;
  expected: string[];
}

export function loadGolden(
  filePath = path.resolve(process.cwd(), 'eval/routing-golden.yaml'),
): GoldenQuery[] {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('routing-golden.yaml must parse to a top-level list of {query, expected}');
  }
  return parsed.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`routing-golden.yaml entry ${i} is not an object`);
    }
    const { query, expected } = item as { query?: unknown; expected?: unknown };
    if (typeof query !== 'string' || query.length === 0) {
      throw new Error(`routing-golden.yaml entry ${i} is missing a non-empty "query"`);
    }
    if (
      !Array.isArray(expected) ||
      expected.length === 0 ||
      expected.length > 3 ||
      !expected.every((e) => typeof e === 'string' && e.length > 0)
    ) {
      throw new Error(
        `routing-golden.yaml entry ${i} ("${query}") must have "expected" as 1-3 non-empty strings`,
      );
    }
    return { query, expected: expected as string[] };
  });
}

// DCG@k with binary relevance (1 if the source is in `expected`, else 0),
// standard log2(rank+1) discount, ranks 1-indexed. nDCG itself is only ever
// reported at k=5 (stage 2's max_sources default), so only that cutoff has
// a dedicated ideal-DCG helper.
function dcgAtK(rankedNames: string[], expected: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedNames.length); i++) {
    if (expected.has(rankedNames[i])) dcg += 1 / Math.log2(i + 2);
  }
  return dcg;
}

function idealDcgAt5(expectedCount: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(5, expectedCount); i++) dcg += 1 / Math.log2(i + 2);
  return dcg;
}

export function ndcgAt5(rankedNames: string[], expected: Set<string>): number {
  const ideal = idealDcgAt5(expected.size);
  return ideal === 0 ? 0 : dcgAtK(rankedNames, expected, 5) / ideal;
}

function recallAtK(rankedNames: string[], expected: Set<string>, k: number): number {
  if (expected.size === 0) return 0;
  const topK = new Set(rankedNames.slice(0, k));
  let hit = 0;
  for (const e of expected) if (topK.has(e)) hit += 1;
  return hit / expected.size;
}

export function recallAt5(rankedNames: string[], expected: Set<string>): number {
  return recallAtK(rankedNames, expected, 5);
}

export function recallAt20(rankedNames: string[], expected: Set<string>): number {
  return recallAtK(rankedNames, expected, 20);
}

export interface ClusterScores {
  ndcg: number[];
  recall5: number[];
  recall20: number[]; // only populated when the caller asked for it (stage 1)
  skippedHiddenExpected: number; // count of individual expected sources dropped for being hidden
  skippedQueries: number; // count of queries excluded entirely (every expected source was hidden)
}

function emptyClusterScores(): ClusterScores {
  return { ndcg: [], recall5: [], recall20: [], skippedHiddenExpected: 0, skippedQueries: 0 };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// A query is grouped under the cluster of its first expected source, for
// per-cluster reporting only; scoring itself is cluster-agnostic. Uses the
// full (not hidden-filtered) expected list, so a query still reports under
// its natural cluster even when that first source is the one being skipped.
function clusterOfQuery(query: GoldenQuery, clusterByName: Map<string, string>): string {
  return clusterByName.get(query.expected[0]) ?? 'unknown';
}

export function score(
  golden: GoldenQuery[],
  clusterByName: Map<string, string>,
  hiddenNames: Set<string>,
  rank: (q: GoldenQuery) => string[],
  opts: { includeRecall20: boolean },
): { byCluster: Map<string, ClusterScores>; overall: ClusterScores } {
  const byCluster = new Map<string, ClusterScores>();
  const overall = emptyClusterScores();

  for (const q of golden) {
    const cluster = clusterOfQuery(q, clusterByName);
    const entry = byCluster.get(cluster) ?? emptyClusterScores();
    byCluster.set(cluster, entry);

    const visibleExpected = q.expected.filter((s) => !hiddenNames.has(s));
    const hiddenCount = q.expected.length - visibleExpected.length;
    entry.skippedHiddenExpected += hiddenCount;
    overall.skippedHiddenExpected += hiddenCount;

    if (visibleExpected.length === 0) {
      // Every expected source is hidden: scoring this query against an
      // empty expected set would either be undefined or a guaranteed zero,
      // neither of which says anything about routing quality. Exclude it
      // from the averages entirely instead.
      entry.skippedQueries += 1;
      overall.skippedQueries += 1;
      continue;
    }

    const ranked = rank(q);
    const expected = new Set(visibleExpected);
    const ndcg = ndcgAt5(ranked, expected);
    const recall5 = recallAt5(ranked, expected);
    overall.ndcg.push(ndcg);
    overall.recall5.push(recall5);
    entry.ndcg.push(ndcg);
    entry.recall5.push(recall5);
    if (opts.includeRecall20) {
      const recall20 = recallAt20(ranked, expected);
      overall.recall20.push(recall20);
      entry.recall20.push(recall20);
    }
  }
  return { byCluster, overall };
}

// True when every one of a query's expected sources is currently hidden -
// used before calling `rank()` so stage 2 doesn't spend a live LLM call on
// a query score() is only going to exclude anyway.
function isFullyHidden(q: GoldenQuery, hiddenNames: Set<string>): boolean {
  return q.expected.every((s) => hiddenNames.has(s));
}

function printReport(
  label: string,
  result: { byCluster: Map<string, ClusterScores>; overall: ClusterScores },
  includeRecall20: boolean,
): void {
  console.log(`\n${label}`);
  const header = [
    'cluster'.padEnd(16),
    'n'.padStart(4),
    'nDCG@5'.padStart(8),
    'recall@5'.padStart(10),
  ];
  if (includeRecall20) header.push('recall@20'.padStart(11));
  console.log(...header);

  const printRow = (name: string, s: ClusterScores) => {
    const row = [
      name.padEnd(16),
      String(s.ndcg.length).padStart(4),
      mean(s.ndcg).toFixed(3).padStart(8),
      mean(s.recall5).toFixed(3).padStart(10),
    ];
    if (includeRecall20) row.push(mean(s.recall20).toFixed(3).padStart(11));
    console.log(...row);
    console.log(
      ''.padEnd(16),
      `skipped hidden expected: ${s.skippedHiddenExpected}, skipped queries: ${s.skippedQueries}`,
    );
  };

  for (const [cluster, s] of [...result.byCluster.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    printRow(cluster, s);
  }
  printRow('OVERALL', result.overall);
}

export async function main(): Promise<void> {
  // Same dispatcher production installs at startup (src/index.ts): the
  // router LLM call this eval makes (when a router role is configured)
  // should go through the same connection pooling and caching production
  // traffic does.
  installDispatcher();
  const golden = loadGolden();
  const clusterByName = new Map(listSources().map((s) => [s.name, s.cluster as string]));
  const hiddenNames = new Set(
    listSources()
      .filter((s) => s.hidden)
      .map((s) => s.name),
  );
  const embeddingsConfigured = hasEmbeddingsConfigured();

  const stage1Names = new Map<string, string[]>();
  for (const q of golden) {
    if (isFullyHidden(q, hiddenNames)) continue;
    const ranked = await candidates(q.query, 20);
    stage1Names.set(
      q.query,
      ranked.map((c) => c.name),
    );
  }
  const stage1Result = score(
    golden,
    clusterByName,
    hiddenNames,
    (q) => stage1Names.get(q.query) ?? [],
    { includeRecall20: true },
  );
  printReport(
    `Stage 1 (${embeddingsConfigured ? 'cosine, embeddings configured' : 'BM25 fallback, no embeddings configured'})`,
    stage1Result,
    true,
  );

  const routerConfigured = Boolean(roleConfig('router').apiKey);
  if (routerConfigured) {
    const stage2Names = new Map<string, string[]>();
    // Task 6: how many LLM calls a real library_ask call would actually
    // make under this configuration - the Task 5 llmCalls counter, read
    // through the same requestContext.run({tool: 'library_ask'}) scope
    // index.ts's withRequestContext() wraps a real tool call in, around
    // the exact planRoute() call library_ask's own runAsk() makes (fan-out
    // itself never calls an LLM, so metering planRoute() alone is
    // equivalent to metering the whole tool call). resetMetricsForTests()
    // just before this loop, not resetting per-query, so the total divides
    // cleanly by the query count for an average.
    resetMetricsForTests();
    let queriesRun = 0;
    let skippedCount = 0;
    for (const q of golden) {
      if (isFullyHidden(q, hiddenNames)) continue;
      queriesRun += 1;
      try {
        const planned = await requestContext.run({ reqId: randomUUID(), tool: 'library_ask' }, () =>
          planRoute(q.query, { maxSources: 5 }),
        );
        if (planned.stage2 === 'skipped') skippedCount += 1;
        stage2Names.set(
          q.query,
          planned.routes.map((r) => r.source),
        );
      } catch (err) {
        console.error(
          `stage 1+2: "${q.query}" failed: ${err instanceof Error ? err.message : err}`,
        );
        stage2Names.set(q.query, []);
      }
    }
    const stage2Result = score(
      golden,
      clusterByName,
      hiddenNames,
      (q) => stage2Names.get(q.query) ?? [],
      { includeRecall20: false },
    );
    printReport('Stage 1+2 (router configured)', stage2Result, false);

    const askLlmCalls = toolMetrics('library_ask').llmCalls;
    console.log(
      `\nlibrary_ask_llm_calls_total=${askLlmCalls} library_ask_llm_calls_avg=${(askLlmCalls / (queriesRun || 1)).toFixed(3)} queries=${queriesRun} stage2_skipped=${skippedCount} stage2_llm=${queriesRun - skippedCount}`,
    );
  } else {
    console.log(
      '\nStage 1+2: skipped, no router role configured (set OPENAI_API_KEY or ALEXANDRIA_ROUTER_API_KEY)',
    );
  }

  const stage1Ndcg = mean(stage1Result.overall.ndcg);
  const stage1Recall20 = mean(stage1Result.overall.recall20);
  console.log(
    `\nstage1_ndcg_at_5=${stage1Ndcg.toFixed(4)} stage1_recall_at_20=${stage1Recall20.toFixed(4)} embeddings_configured=${embeddingsConfigured}`,
  );
  if (embeddingsConfigured) {
    const failures: string[] = [];
    if (stage1Ndcg < 0.6) {
      failures.push(`stage-1 nDCG@5 ${stage1Ndcg.toFixed(4)} is below the 0.60 floor`);
    }
    if (stage1Recall20 < 0.8) {
      failures.push(`stage-1 recall@20 ${stage1Recall20.toFixed(4)} is below the 0.80 floor`);
    }
    if (failures.length > 0) {
      console.error(`GATE FAILED: ${failures.join('; ')}`);
      process.exit(1);
    }
  }
}

if (process.argv[1]?.endsWith('eval-routing.ts') || process.argv[1]?.endsWith('eval-routing.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
