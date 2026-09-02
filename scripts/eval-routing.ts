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
// Exit code: 1 only when embeddings ARE configured and stage-1 nDCG@5 is
// below the 0.60 floor (a regression in the ranking that's supposed to be
// this deployment's real one); otherwise this only prints and exits 0, so a
// BM25-only run (no embeddings key at all, the common case for CI) never
// fails the gate on ranking quality it can't yet improve.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import '../src/sources/all.js';
import { listSources } from '../src/sources/registry.js';
import { planRoute } from '../src/tools/libraryAsk.js';
import { candidates } from '../src/utils/catalogIndex.js';
import { hasEmbeddingsConfigured, roleConfig } from '../src/utils/providers.js';

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

// DCG@5 with binary relevance (1 if the source is in `expected`, else 0),
// standard log2(rank+1) discount, ranks 1-indexed.
function dcgAt5(rankedNames: string[], expected: Set<string>): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(5, rankedNames.length); i++) {
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
  return ideal === 0 ? 0 : dcgAt5(rankedNames, expected) / ideal;
}

export function recallAt5(rankedNames: string[], expected: Set<string>): number {
  if (expected.size === 0) return 0;
  const top5 = new Set(rankedNames.slice(0, 5));
  let hit = 0;
  for (const e of expected) if (top5.has(e)) hit += 1;
  return hit / expected.size;
}

interface ClusterScores {
  ndcg: number[];
  recall: number[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// A query is grouped under the cluster of its first expected source, for
// per-cluster reporting only; scoring itself is cluster-agnostic.
function clusterOfQuery(query: GoldenQuery, clusterByName: Map<string, string>): string {
  return clusterByName.get(query.expected[0]) ?? 'unknown';
}

function score(
  golden: GoldenQuery[],
  clusterByName: Map<string, string>,
  rank: (q: GoldenQuery) => string[],
): { byCluster: Map<string, ClusterScores>; overall: ClusterScores } {
  const byCluster = new Map<string, ClusterScores>();
  const overall: ClusterScores = { ndcg: [], recall: [] };
  for (const q of golden) {
    const ranked = rank(q);
    const expected = new Set(q.expected);
    const ndcg = ndcgAt5(ranked, expected);
    const recall = recallAt5(ranked, expected);
    overall.ndcg.push(ndcg);
    overall.recall.push(recall);
    const cluster = clusterOfQuery(q, clusterByName);
    const entry = byCluster.get(cluster) ?? { ndcg: [], recall: [] };
    entry.ndcg.push(ndcg);
    entry.recall.push(recall);
    byCluster.set(cluster, entry);
  }
  return { byCluster, overall };
}

function printReport(
  label: string,
  result: { byCluster: Map<string, ClusterScores>; overall: ClusterScores },
): void {
  console.log(`\n${label}`);
  console.log('cluster'.padEnd(16), 'n'.padStart(4), 'nDCG@5'.padStart(8), 'recall@5'.padStart(10));
  for (const [cluster, s] of [...result.byCluster.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(
      cluster.padEnd(16),
      String(s.ndcg.length).padStart(4),
      mean(s.ndcg).toFixed(3).padStart(8),
      mean(s.recall).toFixed(3).padStart(10),
    );
  }
  console.log(
    'OVERALL'.padEnd(16),
    String(result.overall.ndcg.length).padStart(4),
    mean(result.overall.ndcg).toFixed(3).padStart(8),
    mean(result.overall.recall).toFixed(3).padStart(10),
  );
}

export async function main(): Promise<void> {
  const golden = loadGolden();
  const clusterByName = new Map(listSources().map((s) => [s.name, s.cluster as string]));
  const embeddingsConfigured = hasEmbeddingsConfigured();

  const stage1Names = new Map<string, string[]>();
  for (const q of golden) {
    const ranked = await candidates(q.query, 20);
    stage1Names.set(
      q.query,
      ranked.map((c) => c.name),
    );
  }
  const stage1Result = score(golden, clusterByName, (q) => stage1Names.get(q.query) ?? []);
  printReport(
    `Stage 1 (${embeddingsConfigured ? 'cosine, embeddings configured' : 'BM25 fallback, no embeddings configured'})`,
    stage1Result,
  );

  const routerConfigured = Boolean(roleConfig('router').apiKey);
  if (routerConfigured) {
    const stage2Names = new Map<string, string[]>();
    for (const q of golden) {
      try {
        const planned = await planRoute(q.query, { maxSources: 5 });
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
    const stage2Result = score(golden, clusterByName, (q) => stage2Names.get(q.query) ?? []);
    printReport('Stage 1+2 (router configured)', stage2Result);
  } else {
    console.log(
      '\nStage 1+2: skipped, no router role configured (set OPENAI_API_KEY or ALEXANDRIA_ROUTER_API_KEY)',
    );
  }

  const stage1Ndcg = mean(stage1Result.overall.ndcg);
  console.log(
    `\nstage1_ndcg_at_5=${stage1Ndcg.toFixed(4)} embeddings_configured=${embeddingsConfigured}`,
  );
  if (embeddingsConfigured && stage1Ndcg < 0.6) {
    console.error(`GATE FAILED: stage-1 nDCG@5 ${stage1Ndcg.toFixed(4)} is below the 0.60 floor`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('eval-routing.ts') || process.argv[1]?.endsWith('eval-routing.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
