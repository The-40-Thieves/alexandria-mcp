// `npm run eval:answer`: scores library_answer's citation quality against
// the hand-written golden set at eval/answer-golden.yaml (Task 8).
//
// Needs both a `synth` and an `embeddings` role configured - library_answer
// itself requires synth (requireRoleForTool), and embeddings materially
// improves the routing that decides which sources get read and cited. Like
// eval:routing, this prints a message and exits 0 when either is missing
// rather than failing, since a missing key says nothing about the harness
// itself being broken.
//
// Three metrics, each computed per question and averaged overall (and per
// cluster, grouped the same way eval-routing.ts groups its golden set - by
// the first `expected_sources` entry's own registry cluster, for the table
// only, not for scoring):
//
//   citation precision - for every sentence in the answer that carries a
//     citation marker, does the text of its cited source(s) actually
//     WARRANT the sentence - not merely overlap in topic, but the same
//     strength, scope, and time (the warrant-strength rubric from
//     research/retrieval-sota.md section 4)? Judged with one chatJSON call
//     per cited sentence, via CLAIM_SUPPORT_ROLE below (today: 'synth';
//     Task 9 adds a dedicated 'verify' role, and this constant is the one
//     line that needs to change to use it once it exists). A sentence
//     whose cited source(s) couldn't be re-read at all is excluded from
//     the denominator rather than counted as unwarranted - there's nothing
//     to judge it against, which is a different failure than "judged and
//     found unsupported".
//   nugget recall - of the golden question's expected_nuggets, how many
//     are covered by at least one of the answer's CITED sentences? Judged
//     the same warrant-strength way (nugget as the claim, the joined cited
//     sentences as the evidence) - uncited prose doesn't count, since an
//     uncited claim isn't "covered by a cited sentence". The brief's
//     "Interfaces produced" line names this metric twice, once as
//     "citation recall" ("nuggets covered by a cited sentence", per its
//     own item 2) and again as "answer nugget recall" - they are the same
//     computation under two names; this script reports it once, as
//     nugget_recall.
//   resolvability - of the citations that carry a URL, or an `id` shaped
//     like a DOI, what fraction resolve with a 2xx on a guarded HEAD
//     (falling back to GET) through src/web/fetchTier.ts's
//     assertFetchableUrl, with a 5s timeout? Citations with neither a URL
//     nor a DOI-shaped id are excluded from the denominator. Capped at 20
//     checks per question.
//
// Exit code: unlike eval:routing, this never fails on the SCORES - the
// first run of this harness in docs/answer-eval.md IS the baseline, so
// there is no floor yet to regress against. `--gate` instead fails (exit
// 1) on an infrastructure problem: the required roles missing, or a golden
// question's library_answer call throwing outright - so a CI environment
// that expects this eval to actually run can catch "it silently no-op'd"
// or "it crashed", without asserting a numeric floor nobody has earned yet.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import '../src/sources/all.ts';
import { getAdapter, listSources } from '../src/sources/registry.ts';
import {
  type Citation,
  extractCitationNumbers,
  libraryAnswer,
  splitSentences,
} from '../src/tools/libraryAnswer.ts';
import { guardedDispatcher, installDispatcher } from '../src/utils/dispatcher.ts';
import { fetchWithRetry } from '../src/utils/http.ts';
import {
  chatJSON,
  hasEmbeddingsConfigured,
  type Role,
  roleConfig,
} from '../src/utils/providers.ts';
import { assertFetchableUrl } from '../src/web/fetchTier.ts';

// Task 9 adds a `verify` role dedicated to citation entailment checks
// (falling back to `synth` when unset); until then this always reads
// `synth`, from a single named constant so flipping it later is a one-line
// change rather than a rewrite of this script.
const CLAIM_SUPPORT_ROLE: Role = 'synth';

// Same limit libraryAnswer.ts's own READ_CHAR_LIMIT uses for the text it
// hands the synth role - not exported from there, so duplicated here
// rather than widening that module's public surface for one constant.
const READ_CHAR_LIMIT = 6000;

// Mirrors src/tools/libraryCitations.ts's own (unexported) DOI_RE.
const DOI_RE = /^10\.\d{4,9}\/\S+$/i;

const MAX_RESOLVABILITY_CHECKS_PER_QUESTION = 20;
const RESOLVE_TIMEOUT_MS = 5_000;

export interface AnswerGoldenQuery {
  query: string;
  expected_nuggets: string[];
  expected_sources: string[];
}

export function loadAnswerGolden(
  filePath = path.resolve(process.cwd(), 'eval/answer-golden.yaml'),
): AnswerGoldenQuery[] {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      'answer-golden.yaml must parse to a top-level list of {query, expected_nuggets, expected_sources}',
    );
  }
  return parsed.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`answer-golden.yaml entry ${i} is not an object`);
    }
    const { query, expected_nuggets, expected_sources } = item as {
      query?: unknown;
      expected_nuggets?: unknown;
      expected_sources?: unknown;
    };
    if (typeof query !== 'string' || query.length === 0) {
      throw new Error(`answer-golden.yaml entry ${i} is missing a non-empty "query"`);
    }
    if (
      !Array.isArray(expected_nuggets) ||
      expected_nuggets.length < 3 ||
      expected_nuggets.length > 6 ||
      !expected_nuggets.every((n) => typeof n === 'string' && n.length > 0)
    ) {
      throw new Error(
        `answer-golden.yaml entry ${i} ("${query}") must have "expected_nuggets" as 3-6 non-empty strings`,
      );
    }
    if (
      !Array.isArray(expected_sources) ||
      expected_sources.length === 0 ||
      !expected_sources.every((s) => typeof s === 'string' && s.length > 0)
    ) {
      throw new Error(
        `answer-golden.yaml entry ${i} ("${query}") must have "expected_sources" as 1 or more non-empty strings`,
      );
    }
    return {
      query,
      expected_nuggets: expected_nuggets as string[],
      expected_sources: expected_sources as string[],
    };
  });
}

// A generic true/false fraction, kept distinct from 0 by returning null
// for an empty input - lets a caller tell "nothing to judge" (excluded
// from an average, like eval-routing's skippedQueries) apart from
// "judged, and every one failed" (a real 0).
export function fraction(results: boolean[]): number | null {
  if (results.length === 0) return null;
  return results.filter(Boolean).length / results.length;
}

export interface QueryJudgments {
  citationEntailed: boolean[]; // one per judgeable cited sentence
  nuggetCovered: boolean[]; // one per expected nugget (always present)
  resolved: boolean[]; // one per checkable citation (url or DOI-shaped id)
}

export interface QueryScore {
  citationPrecision: number | null;
  nuggetRecall: number;
  resolvability: number | null;
}

// Pure scoring: turns already-computed judgments into the three per-query
// metrics. Kept separate from scoreQuestion() (which makes the LLM/network
// calls to produce those judgments) so this half is unit-testable with
// fixture booleans and no mocking.
export function scoreAnswerQuery(j: QueryJudgments): QueryScore {
  return {
    citationPrecision: fraction(j.citationEntailed),
    // Always a definite number in real use (loadAnswerGolden requires 3-6
    // nuggets per entry, so nuggetCovered is never empty there); the `?? 0`
    // only matters for a fixture test that passes an empty array directly.
    nuggetRecall: fraction(j.nuggetCovered) ?? 0,
    resolvability: fraction(j.resolved),
  };
}

const WARRANT_SYSTEM_PROMPT = `You are a strict fact-checker applying a warrant-strength rubric.

Given a CLAIM and a SOURCE TEXT, decide whether the source text actually WARRANTS the claim - not merely whether they are on the same topic. The claim is warranted only when the source supports it at the same:
- strength (a source that says something "may" happen or "is associated with" X does not warrant a claim that X definitely happens or is caused)
- scope (a source about one country, dataset, version, or population does not warrant a claim generalized beyond it)
- time (a source describing a past or point-in-time state does not warrant a claim about the current, ongoing, or future state, unless the source itself says so)

Respond with JSON only: {"warranted": true} or {"warranted": false}.`;

const warrantSchema = z.object({ warranted: z.boolean() });

// One entailment primitive, reused for both metrics: citation precision
// asks it with (cited sentence, cited source text); nugget recall asks it
// with (expected nugget, the answer's cited sentences) - "is this nugget
// covered by a cited sentence" is exactly "does this evidence warrant this
// claim" with the claim and evidence swapped in.
async function judgeWarranted(role: Role, claim: string, evidence: string): Promise<boolean> {
  const user = `CLAIM:\n${claim}\n\nSOURCE TEXT:\n${evidence}`;
  const result = await chatJSON(role, WARRANT_SYSTEM_PROMPT, user, warrantSchema);
  return result.warranted;
}

async function checkResolvable(url: string): Promise<boolean> {
  try {
    await assertFetchableUrl(url);
  } catch {
    return false;
  }
  // HEAD first (cheap); some servers 405/501 on HEAD or lie about it, so a
  // non-ok or failed HEAD falls back to a GET before giving up. retries: 0
  // on both - this is a liveness probe, not a content fetch, so a single
  // failed attempt per method is enough to call a target unresolvable
  // rather than spending fetchWithRetry's default retry budget on it.
  try {
    const head = await fetchWithRetry(
      url,
      { method: 'HEAD', dispatcher: guardedDispatcher },
      RESOLVE_TIMEOUT_MS,
      0,
    );
    if (head.ok) return true;
  } catch {
    // fall through to GET
  }
  try {
    const get = await fetchWithRetry(
      url,
      { method: 'GET', dispatcher: guardedDispatcher },
      RESOLVE_TIMEOUT_MS,
      0,
    );
    return get.ok;
  } catch {
    return false;
  }
}

function resolvabilityTarget(citation: Citation): string | undefined {
  if (citation.url) return citation.url;
  return DOI_RE.test(citation.id) ? `https://doi.org/${citation.id}` : undefined;
}

async function scoreQuestion(
  entry: AnswerGoldenQuery,
  role: Role,
): Promise<{ judgments: QueryJudgments; warnings: string[] }> {
  const result = await libraryAnswer(entry.query);
  const citationByN = new Map(result.citations.map((c) => [c.n, c]));

  const citedSentences: { sentence: string; nums: number[] }[] = [];
  for (const sentence of splitSentences(result.answer)) {
    const nums = extractCitationNumbers(sentence).filter((n) => citationByN.has(n));
    if (nums.length > 0) citedSentences.push({ sentence, nums });
  }

  // Re-reads each cited source's text through the same adapter.read() path
  // libraryAnswer.ts's own readTopSources used to build the answer - its
  // return shape doesn't carry that text back out, so this is a second
  // read rather than a reuse of the first. Cached per citation number so a
  // source cited by several sentences is only read once per question.
  const chunkTextCache = new Map<number, string | null>();
  async function chunkText(n: number): Promise<string | null> {
    if (chunkTextCache.has(n)) return chunkTextCache.get(n) ?? null;
    const citation = citationByN.get(n);
    if (!citation) return null;
    let text: string | null = null;
    try {
      const read = await getAdapter(citation.source).read(citation.id);
      if (!read.metadataOnly && read.text) text = read.text.slice(0, READ_CHAR_LIMIT);
    } catch {
      text = null;
    }
    chunkTextCache.set(n, text);
    return text;
  }

  const citationEntailed: boolean[] = [];
  for (const { sentence, nums } of citedSentences) {
    const texts = (await Promise.all(nums.map((n) => chunkText(n)))).filter(
      (t): t is string => t !== null,
    );
    if (texts.length === 0) continue; // couldn't re-read any cited source - not judgeable either way
    citationEntailed.push(await judgeWarranted(role, sentence, texts.join('\n\n---\n\n')));
  }

  const citedText = citedSentences.map((c) => c.sentence).join(' ');
  const nuggetCovered: boolean[] = [];
  for (const nugget of entry.expected_nuggets) {
    nuggetCovered.push(citedText.length > 0 && (await judgeWarranted(role, nugget, citedText)));
  }

  const targets = result.citations
    .map(resolvabilityTarget)
    .filter((t): t is string => Boolean(t))
    .slice(0, MAX_RESOLVABILITY_CHECKS_PER_QUESTION);
  const resolved = await Promise.all(targets.map(checkResolvable));

  return { judgments: { citationEntailed, nuggetCovered, resolved }, warnings: result.warnings };
}

interface AggregateStats {
  n: number;
  citationPrecision: number[];
  nuggetRecall: number[];
  resolvability: number[];
  skippedPrecision: number; // queries with no judgeable cited sentence
  skippedResolvability: number; // queries with no checkable citation
}

function emptyStats(): AggregateStats {
  return {
    n: 0,
    citationPrecision: [],
    nuggetRecall: [],
    resolvability: [],
    skippedPrecision: 0,
    skippedResolvability: 0,
  };
}

function addScore(stats: AggregateStats, score: QueryScore): void {
  stats.n += 1;
  if (score.citationPrecision === null) stats.skippedPrecision += 1;
  else stats.citationPrecision.push(score.citationPrecision);
  stats.nuggetRecall.push(score.nuggetRecall);
  if (score.resolvability === null) stats.skippedResolvability += 1;
  else stats.resolvability.push(score.resolvability);
}

// NaN (not 0) for an empty input - `mean(s.citationPrecision)` and
// `mean(s.resolvability)` are means over a filtered, judgeable-only list
// (skippedPrecision/skippedResolvability track what was excluded), so an
// empty list means "nothing was judgeable here", not "everything scored
// zero". Number.prototype.toFixed(n) prints NaN as the literal string
// "NaN" (verified live), so every call site below stays a plain
// `.toFixed()` and still reads unambiguously rather than silently
// reporting a 0.000 that looks like a real, bad score.
function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function printReport(byCluster: Map<string, AggregateStats>, overall: AggregateStats): void {
  console.log('\nAnswer/citation eval');
  console.log(
    'cluster'.padEnd(16),
    'n'.padStart(4),
    'precision'.padStart(10),
    'nugget_recall'.padStart(14),
    'resolvability'.padStart(14),
  );

  const printRow = (name: string, s: AggregateStats) => {
    console.log(
      name.padEnd(16),
      String(s.n).padStart(4),
      mean(s.citationPrecision).toFixed(3).padStart(10),
      mean(s.nuggetRecall).toFixed(3).padStart(14),
      mean(s.resolvability).toFixed(3).padStart(14),
    );
    console.log(
      ''.padEnd(16),
      `skipped precision (no judgeable citation): ${s.skippedPrecision}, skipped resolvability (no url/DOI): ${s.skippedResolvability}`,
    );
  };

  for (const [cluster, s] of [...byCluster.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    printRow(cluster, s);
  }
  printRow('OVERALL', overall);
}

export async function main(): Promise<void> {
  const gate = process.argv.includes('--gate');
  installDispatcher();
  const golden = loadAnswerGolden();
  const clusterByName = new Map(listSources().map((s) => [s.name, s.cluster as string]));

  const synthConfigured = Boolean(roleConfig('synth').apiKey);
  const embeddingsConfigured = hasEmbeddingsConfigured();
  if (!synthConfigured || !embeddingsConfigured) {
    console.log(
      `eval:answer skipped: library_answer needs both a synth and an embeddings role configured (synth configured: ${synthConfigured}, embeddings configured: ${embeddingsConfigured}). Set OPENAI_API_KEY, or ALEXANDRIA_SYNTH_API_KEY / ALEXANDRIA_EMBEDDINGS_API_KEY.`,
    );
    console.log(
      '\ncitation_precision=NaN nugget_recall=NaN resolvability=NaN roles_configured=false',
    );
    if (gate) process.exit(1);
    return;
  }

  const byCluster = new Map<string, AggregateStats>();
  const overall = emptyStats();
  let failures = 0;

  for (const entry of golden) {
    const cluster = clusterByName.get(entry.expected_sources[0]) ?? 'unknown';
    const bucket = byCluster.get(cluster) ?? emptyStats();
    byCluster.set(cluster, bucket);

    try {
      const { judgments } = await scoreQuestion(entry, CLAIM_SUPPORT_ROLE);
      const scored = scoreAnswerQuery(judgments);
      addScore(bucket, scored);
      addScore(overall, scored);
    } catch (err) {
      console.error(`"${entry.query}" failed: ${err instanceof Error ? err.message : err}`);
      failures += 1;
    }
  }

  printReport(byCluster, overall);

  const precisionMean = mean(overall.citationPrecision);
  const recallMean = mean(overall.nuggetRecall);
  const resolvabilityMean = mean(overall.resolvability);
  console.log(
    `\ncitation_precision=${precisionMean.toFixed(4)} nugget_recall=${recallMean.toFixed(4)} resolvability=${resolvabilityMean.toFixed(4)} roles_configured=true`,
  );

  if (gate && failures > 0) {
    console.error(`GATE FAILED: ${failures} of ${golden.length} golden question(s) failed to run`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('eval-answer.ts') || process.argv[1]?.endsWith('eval-answer.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
