// THE-317/319/320: library_research (Stage 9, task 9.2). A recursive
// research loop shaped after the Trigger.dev/AI SDK "deep research"
// pattern: generate queries -> answer each with library_answer -> extract
// learnings/follow-ups -> recurse with half the breadth, until depth 0, the
// time budget, or a round finds no new sources. A final report is written
// over the union of every round's citations, then checked for unsupported
// claims and trimmed.
import pLimit from 'p-limit';
import { z } from 'zod';
import { chatJSON, requireRoleForTool } from '../utils/providers.js';
import {
  type Citation,
  type LibraryAnswerOptions,
  type LibraryAnswerResult,
  libraryAnswer,
} from './libraryAnswer.js';

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

// Asks the `synth` role to list any sentences whose claim isn't actually
// supported by the given sources, then removes those exact sentences from
// the report (an in-code removal, not trusting the model to self-edit).
async function checkCitations(report: string, citations: Citation[]): Promise<string> {
  const system = `You fact-check a research report against its numbered sources. List every sentence in the report whose claim is not adequately supported by the cited source(s), verbatim as it appears in the report.

Return JSON: { "unsupported": ["exact sentence 1", ...] }
Return an empty array if every sentence is adequately supported.`;
  const sourcesBlock = citations.map((c) => `[${c.n}] ${c.title} (${c.source}:${c.id})`).join('\n');
  const user = `Report:\n${report}\n\nSources:\n${sourcesBlock}`;
  const result = await chatJSON('synth', system, user, CitationCheckSchema);
  if (result.unsupported.length === 0) return report;

  let cleaned = report;
  for (const sentence of result.unsupported) {
    if (sentence) cleaned = cleaned.split(sentence).join('');
  }
  return cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

    await emitProgress(onProgress, {
      round: thisRound,
      message: `round ${thisRound}: ${newSourceCount} new source(s), ${newLearnings.length} learning(s)`,
    });

    if (newSourceCount === 0) return;
    if (Date.now() >= deadline) return;

    await runRound(depthRemaining - 1, Math.ceil(breadthNow / 2));
  }

  await runRound(depth, breadth);

  const finalCitations = renumber(unionCitations);
  let report: string;
  if (finalCitations.length === 0) {
    report = 'No sources were found for this topic; not found in the sources.';
  } else {
    const draft = await writeReport(query, learnings, finalCitations);
    report = await checkCitations(draft, finalCitations);
  }

  return {
    report,
    citations: finalCitations,
    rounds,
    elapsedMs: Date.now() - startedAt,
  };
}
