// THE-317/319/320: library_research (Stage 9, task 9.2). A recursive
// research loop shaped after the Trigger.dev/AI SDK "deep research"
// pattern: generate queries -> answer each with library_answer -> extract
// learnings/follow-ups -> recurse with half the breadth, until depth 0, the
// time budget, or a round finds no new sources. A final report is written
// over the union of every round's citations, then checked for unsupported
// claims and trimmed.
import pLimit from 'p-limit';
import { z } from 'zod';
import { requestLogger } from '../log.ts';
import { gradeCitation, retractedWarning } from '../utils/citationGrade.ts';
import { chatJSON, requireRoleForTool } from '../utils/providers.ts';
import {
  type Citation,
  extractCitationNumbers,
  type LibraryAnswerOptions,
  type LibraryAnswerResult,
  libraryAnswer,
} from './libraryAnswer.ts';

const RESEARCH_CONCURRENCY = 3;

export interface LibraryResearchOptions {
  depth?: number;
  breadth?: number;
  maxMinutes?: number;
}

export interface ResearchRound {
  round: number;
  queries: string[];
  newSources: number;
  truncated: boolean;
}

export interface LibraryResearchResult {
  report: string;
  citations: Citation[];
  rounds: ResearchRound[];
  elapsedMs: number;
  // Unsupported claims the fact-check flagged but that were left standing
  // because removing them was not safe (see checkCitations).
  warnings: string[];
  // Task 11: the outline generateObjectives() produced before round 1, and
  // coverage[i] = whether objectives[i] was covered by a learning as of
  // the last round that ran (index-aligned with objectives). Detailed
  // output only (src/tools/format.ts's research branch), same as rounds/
  // elapsedMs.
  objectives: string[];
  coverage: boolean[];
}

export interface ProgressInfo {
  round: number;
  message: string;
}

export type ProgressCallback = (info: ProgressInfo) => void | Promise<void>;

// Test seam: production callers (src/index.ts) never pass this, so
// libraryResearch always drives the real libraryAnswer pipeline; tests
// inject a canned answerFn to exercise the loop's own stop conditions
// (depth/breadth/time-budget/no-new-sources) without needing a full fake
// routing + adapter + read stack.
export interface LibraryResearchDeps {
  answerFn?: (query: string, opts?: LibraryAnswerOptions) => Promise<LibraryAnswerResult>;
}

async function emitProgress(
  onProgress: ProgressCallback | undefined,
  info: ProgressInfo,
): Promise<void> {
  if (!onProgress) return;
  await onProgress(info);
}

const QueriesSchema = z.object({ queries: z.array(z.string().min(1)) });

async function generateQueries(
  topic: string,
  learnings: string[],
  breadth: number,
): Promise<string[]> {
  const system = `You are planning a research pass on a topic. Generate up to ${breadth} focused search queries that would surface new, useful information.

Return JSON: { "queries": ["query 1", "query 2", ...] }
Generate at most ${breadth} queries.`;
  const learningsBlock =
    learnings.length > 0
      ? `\n\nLearnings so far:\n${learnings.map((l) => `- ${l}`).join('\n')}`
      : '';
  const user = `Topic: ${topic}${learningsBlock}`;
  const decision = await chatJSON('research', system, user, QueriesSchema);
  return decision.queries.slice(0, breadth);
}

const ObjectivesSchema = z.object({ objectives: z.array(z.string().min(1)) });

// Task 11 (brief 07): "Don't Stop Early" coverage-driven stopping (see
// research/retrieval-sota.md section 3) - before round 1, ask the research
// role to outline 3 to 7 concrete objectives a thorough answer on this
// topic would need to cover. Loose like generateQueries()'s breadth
// (instructional count in the prompt, clamped in code) rather than a hard
// schema bound, since retrying a whole research run over an LLM returning
// 2 or 8 objectives instead of "3 to 7" would be a worse failure mode than
// just working with whatever count it gives.
async function generateObjectives(topic: string): Promise<string[]> {
  const system = `You are scoping a research pass on a topic. Outline 3 to 7 concrete coverage objectives: the distinct things a thorough answer would need to address.

Return JSON: { "objectives": ["objective 1", "objective 2", ...] }
Generate between 3 and 7 objectives.`;
  const user = `Topic: ${topic}`;
  const decision = await chatJSON('research', system, user, ObjectivesSchema);
  return decision.objectives.slice(0, 7);
}

const CoverageSchema = z.object({ coveredIndices: z.array(z.number().int()) });

// Re-derives coverage from scratch each round (cumulative learnings so
// far), rather than merging into a running boolean[], so one bad round
// can't leave a stale "covered" stuck from an earlier round's learnings
// that turned out to be off-topic. One chatJSON call per round, per the
// brief.
async function updateCoverage(objectives: string[], learnings: string[]): Promise<boolean[]> {
  const system = `You track coverage of a research outline. Given numbered objectives and the learnings gathered so far, list the objectives that are adequately addressed by at least one learning.

Return JSON: { "coveredIndices": [0, 2, ...] } using the 0-based objective numbers below.`;
  const objectivesBlock = objectives.map((o, i) => `${i}. ${o}`).join('\n');
  const learningsBlock =
    learnings.length > 0 ? learnings.map((l) => `- ${l}`).join('\n') : '(none yet)';
  const user = `Objectives:\n${objectivesBlock}\n\nLearnings so far:\n${learningsBlock}`;
  const decision = await chatJSON('research', system, user, CoverageSchema);
  const covered = new Array(objectives.length).fill(false);
  for (const idx of decision.coveredIndices) {
    if (idx >= 0 && idx < covered.length) covered[idx] = true;
  }
  return covered;
}

const LearningsSchema = z.object({
  learnings: z.array(z.string()),
  followUps: z.array(z.string()),
});

async function extractLearnings(
  answer: string,
): Promise<{ learnings: string[]; followUps: string[] }> {
  const system = `You extract structured learnings from a cited research answer.

Return JSON: { "learnings": ["concise factual learning", ...], "followUps": ["a follow-up question this raises", ...] }`;
  return chatJSON('research', system, answer, LearningsSchema);
}

const ReportSchema = z.object({ report: z.string() });

async function writeReport(
  topic: string,
  learnings: string[],
  citations: Citation[],
): Promise<string> {
  const system = `You write a research report from a set of learnings, citing the numbered sources provided.

Rules:
- Organize the report into sections with headers.
- Every sentence that states a fact must end with one or more citation markers like [n], referencing the numbered sources below.
- Only cite source numbers 1 through ${citations.length}. Never invent a source number.

Return JSON: { "report": "the full report text" }`;
  const sourcesBlock = citations.map((c) => `[${c.n}] ${c.title} (${c.source}:${c.id})`).join('\n');
  const learningsBlock = learnings.map((l) => `- ${l}`).join('\n');
  const user = `Topic: ${topic}\n\nLearnings:\n${learningsBlock}\n\nSources:\n${sourcesBlock}`;
  const decision = await chatJSON('research', system, user, ReportSchema);
  return decision.report;
}

const CitationCheckSchema = z.object({ unsupported: z.array(z.string()) });

// The shortest "sentence" this will cut out of a report. A model asked for
// verbatim sentences sometimes answers with a fragment ("Yes.", "None", a
// single word), and split/join on a short string shreds the report by
// deleting every incidental occurrence of it. Below this length the claim
// is kept and a warning is raised instead.
const MIN_REMOVABLE_CLAIM_CHARS = 20;

export interface CitationCheckResult {
  report: string;
  warnings: string[];
}

// Asks the `synth` role to list any sentences whose claim isn't actually
// supported by the given sources, then removes those exact sentences from
// the report (an in-code removal, not trusting the model to self-edit).
//
// Removal is deliberately conservative: a claim is cut only when it is at
// least MIN_REMOVABLE_CLAIM_CHARS long AND occurs exactly once in the
// report. Anything else is left in place with a warning, because the
// failure mode of a loose match (silently shredding unrelated prose) is far
// worse than leaving one flagged sentence standing where the caller can see
// the warning.
export async function checkCitations(
  report: string,
  citations: Citation[],
): Promise<CitationCheckResult> {
  const system = `You fact-check a research report against its numbered sources. List every sentence in the report whose claim is not adequately supported by the cited source(s), verbatim as it appears in the report.

Return JSON: { "unsupported": ["exact sentence 1", ...] }
Return an empty array if every sentence is adequately supported.`;
  const sourcesBlock = citations.map((c) => `[${c.n}] ${c.title} (${c.source}:${c.id})`).join('\n');
  const user = `Report:\n${report}\n\nSources:\n${sourcesBlock}`;
  const result = await chatJSON('synth', system, user, CitationCheckSchema);
  if (result.unsupported.length === 0) return { report, warnings: [] };

  const warnings: string[] = [];
  let cleaned = report;
  for (const raw of result.unsupported) {
    const sentence = raw?.trim();
    if (!sentence) continue;
    const shown = JSON.stringify(sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence);
    if (sentence.length < MIN_REMOVABLE_CLAIM_CHARS) {
      warnings.push(
        `kept an unsupported claim too short to remove safely (${sentence.length} chars): ${shown}`,
      );
      continue;
    }
    const occurrences = cleaned.split(sentence).length - 1;
    if (occurrences !== 1) {
      warnings.push(
        `kept an unsupported claim that matched ${occurrences} times in the report: ${shown}`,
      );
      continue;
    }
    cleaned = cleaned.split(sentence).join('');
  }

  const tidied = cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { report: tidied, warnings };
}

// Task 9: refines chainSupported (src/utils/citationGrade.ts's signal for
// "this citation's own claim(s) survived library_research's fact-check
// pass") for every citation actually cited in the draft report, then
// re-derives its tier from that plus its ALREADY-computed signals - the
// sourceTier/retracted/citationCount/fullTextVerified each citation's
// originating libraryAnswer() call already looked up, so this needs no new
// network calls. A citation cited in the draft but no longer cited after
// checkCitations() removed its (sole) supporting sentence gets
// chainSupported: false; one still cited either way gets true. A citation
// never cited in the draft at all is left alone (chainSupported stays
// unset - "not applicable", not "failed").
function applyChainSupport(citations: Citation[], draft: string, finalReport: string): void {
  const citedInDraft = new Set(extractCitationNumbers(draft));
  const citedInFinal = new Set(extractCitationNumbers(finalReport));
  for (const c of citations) {
    if (!citedInDraft.has(c.n) || !c.grade) continue;
    c.grade = gradeCitation({ ...c.grade.signals, chainSupported: citedInFinal.has(c.n) });
  }
}

function citationKey(c: Citation): string {
  return `${c.source}:${c.id}`;
}

// Renumbers a deduped union of citations 1..N in first-seen order.
function renumber(citations: Citation[]): Citation[] {
  return citations.map((c, i) => ({ ...c, n: i + 1 }));
}

export async function libraryResearch(
  query: string,
  opts: LibraryResearchOptions = {},
  onProgress?: ProgressCallback,
  deps: LibraryResearchDeps = {},
): Promise<LibraryResearchResult> {
  requireRoleForTool('library_research', 'research');
  requireRoleForTool('library_research', 'synth');

  const answerFn = deps.answerFn ?? libraryAnswer;
  const depth = opts.depth ?? 2;
  const breadth = opts.breadth ?? 4;
  const maxMinutes = opts.maxMinutes ?? 6;

  const startedAt = Date.now();
  const deadline = startedAt + maxMinutes * 60_000;
  const limit = pLimit(RESEARCH_CONCURRENCY);

  const rounds: ResearchRound[] = [];
  const unionCitations: Citation[] = [];
  const seenSourceKeys = new Set<string>();
  let learnings: string[] = [];
  let roundNumber = 0;
  // Declared here (not after the loop, as before this task) so the
  // objective-outline/coverage failure paths below can push onto it - the
  // final block appends checkCitations()'s warnings rather than
  // overwriting, so nothing pushed early is lost.
  const warnings: string[] = [];

  // Task 11: outline once before round 1, then re-checked after every
  // round that runs. The "every objective covered" stop check below is
  // guarded on objectives.length > 0, so an empty outline (the research
  // role declining to name any) never trips it by vacuous truth on an
  // empty array - it just falls back to today's depth/breadth/time/
  // no-new-sources stop conditions.
  //
  // Review round 1 (Important 1): generateObjectives()/updateCoverage()
  // are enrichment on top of the pre-existing stop rules, not core to the
  // research loop - chatJSON throwing (two failed schema validations, or
  // an exhausted network retry) must not sink an otherwise-working
  // research run the way an unguarded await would (the exception
  // propagating out of libraryResearch() to the tool handler's catch,
  // turning the whole call into `isError: true`). Same failure-isolation
  // shape as libraryAnswer.ts's claim-verification/grading try/catches:
  // log at debug, warn, and keep going under today's rules.
  let objectives: string[] = [];
  try {
    objectives = await generateObjectives(query);
  } catch (err) {
    requestLogger().debug(
      { err: err instanceof Error ? err.message : String(err) },
      'objective outline generation failed',
    );
    warnings.push('objective outline unavailable; stopping on depth, breadth, and time only');
  }
  let coverage: boolean[] = objectives.map(() => false);
  let coverageFailureWarned = false;

  async function runRound(depthRemaining: number, breadthNow: number): Promise<void> {
    if (depthRemaining <= 0 || breadthNow <= 0) return;
    if (Date.now() >= deadline) return;

    roundNumber += 1;
    const thisRound = roundNumber;

    const queries = await generateQueries(query, learnings, breadthNow);
    if (queries.length === 0) return;

    await emitProgress(onProgress, {
      round: thisRound,
      message: `round ${thisRound}: searching ${queries.length} queries`,
    });

    // The deadline is also checked here, inside each per-query worker,
    // right before it calls answerFn. Round boundaries alone (the checks
    // above and below) can only stop the *next* round; with concurrency 3,
    // a slow round could otherwise overrun the budget by a full round's
    // worth of calls. Checking per-query caps the overrun at whatever is
    // already in flight (at most RESEARCH_CONCURRENCY calls), and any
    // query skipped this way marks the round truncated.
    let truncated = false;
    const answers = await Promise.all(
      queries.map((q) =>
        limit(() => {
          if (Date.now() >= deadline) {
            truncated = true;
            return undefined;
          }
          return answerFn(q, { readTop: 2 }).catch(() => undefined);
        }),
      ),
    );

    const newLearnings: string[] = [];
    let newSourceCount = 0;

    for (const answer of answers) {
      if (!answer) continue;
      for (const citation of answer.citations) {
        const key = citationKey(citation);
        if (!seenSourceKeys.has(key)) {
          seenSourceKeys.add(key);
          unionCitations.push(citation);
          newSourceCount += 1;
        }
      }
      if (answer.answer) {
        const extracted = await extractLearnings(answer.answer);
        newLearnings.push(...extracted.learnings);
      }
    }

    rounds.push({ round: thisRound, queries, newSources: newSourceCount, truncated });
    learnings = [...learnings, ...newLearnings];
    if (objectives.length > 0) {
      try {
        coverage = await updateCoverage(objectives, learnings);
      } catch (err) {
        requestLogger().debug(
          { err: err instanceof Error ? err.message : String(err) },
          'objective coverage check failed',
        );
        // coverage is left as whatever it was last round (unchanged), per
        // review round 1's ruling - not reset to all-false, which could
        // wrongly re-open an objective a previous round already covered.
        if (!coverageFailureWarned) {
          warnings.push('objective outline unavailable; stopping on depth, breadth, and time only');
          coverageFailureWarned = true;
        }
      }
    }

    await emitProgress(onProgress, {
      round: thisRound,
      message: `round ${thisRound}: ${newSourceCount} new source(s), ${newLearnings.length} learning(s)`,
    });

    if (newSourceCount === 0) return;
    if (Date.now() >= deadline) return;
    if (objectives.length > 0 && coverage.every(Boolean)) return;

    await runRound(depthRemaining - 1, Math.ceil(breadthNow / 2));
  }

  await runRound(depth, breadth);

  const finalCitations = renumber(unionCitations);
  let report: string;
  if (finalCitations.length === 0) {
    report = 'No sources were found for this topic; not found in the sources.';
  } else {
    const draft = await writeReport(query, learnings, finalCitations);
    const checked = await checkCitations(draft, finalCitations);
    report = checked.report;
    warnings.push(...checked.warnings);
    applyChainSupport(finalCitations, draft, report);
    // "Retracted means tier D and a warning" - each citation's own
    // retracted signal was already set by whichever round's libraryAnswer()
    // call graded it; surface it here too since library_research's final
    // warnings[] (unlike grade) is not detailed-output-only.
    for (const c of finalCitations) {
      if (c.grade?.signals.retracted) warnings.push(retractedWarning(c.n, c.title));
    }
  }

  return {
    report,
    citations: finalCitations,
    rounds,
    elapsedMs: Date.now() - startedAt,
    warnings,
    objectives,
    coverage,
  };
}
