// Task 9: Citation.grade (declared by Task 1 in src/index.ts's outputSchema
// as { tier: 'A'|'B'|'C'|'D', signals: record }). A citation's grade is
// deterministic given its signals (gradeFromSignals below is pure and unit
// tested directly); gradeCitations() is the async orchestrator that
// gathers those signals - a static source-tier map, plus a live DOI lookup
// against OpenAlex (batched, one call for every DOI-bearing citation) and,
// for a semanticscholar-sourced citation, that source's own citation
// counts - before calling it.
//
// Enrichment is always best-effort: a failed OpenAlex batch or Semantic
// Scholar lookup just means fewer signals (grading falls back to the
// static sourceTier alone), never a thrown error - a citation's grade
// always resolves.

import { authParam } from '../sources/openalex.ts';
import type { Cluster } from '../sources/registry.ts';
import { s2CitationSignals } from '../sources/semanticscholar.ts';
import { fetchJSON } from './http.ts';

export type SourceTier = 1 | 2 | 3 | 4;
export type GradeTier = 'A' | 'B' | 'C' | 'D';

export interface GradeSignals {
  sourceTier: SourceTier;
  retracted?: boolean;
  citationCount?: number;
  influentialCitations?: number;
  year?: number;
  fullTextVerified: boolean;
  chainSupported?: boolean;
}

export interface CitationGrade {
  tier: GradeTier;
  signals: GradeSignals;
}

// ─── Static source tier ─────────────────────────────────────────────────
//
// Per the brief's rubric: peer-reviewed OA journals and indexes = 1,
// preprint servers = 2, libraries/archives/government = 2, RSS/news/web
// fetch = 4. Everything else (developer docs, law, security, standards,
// markets, economics, real_estate, geopolitical, video, and the academic
// cluster's own preprint servers below) defaults to 3 - a middle tier for
// "not independently peer-reviewed or indexed, but not an
// RSS/news/web-fetch grab either" - rather than guessing it belongs at
// either extreme the brief did name.
const PREPRINT_SOURCES: ReadonlySet<string> = new Set([
  'arxiv',
  'biorxiv',
  'medrxiv',
  'osf',
  'hfpapers',
]);

const CLUSTER_SOURCE_TIER: Partial<Record<Cluster, SourceTier>> = {
  academic: 1, // peer-reviewed OA journals and indexes (minus PREPRINT_SOURCES above)
  literature: 2, // libraries
  culture: 2, // libraries
  archives: 2, // archives
  government: 2, // government
  news_global: 4,
  news_regional: 4,
  web: 4, // RSS, news, web fetch
};
const DEFAULT_SOURCE_TIER: SourceTier = 3;

export function sourceTierFor(source: string, cluster?: string): SourceTier {
  if (PREPRINT_SOURCES.has(source)) return 2;
  if (cluster && cluster in CLUSTER_SOURCE_TIER) {
    return CLUSTER_SOURCE_TIER[cluster as Cluster] as SourceTier;
  }
  return DEFAULT_SOURCE_TIER;
}

// OpenAlex's own per-work venue classification, used to refine the static
// sourceTier above when live data disagrees with it (e.g. a doaj-indexed
// item that OpenAlex's primary_location.source.type marks 'repository'
// rather than 'journal'). An unrecognized/unset type leaves the static
// tier as-is rather than guessing.
function tierFromOpenAlexSourceType(type: string | undefined): SourceTier | undefined {
  switch (type) {
    case 'journal':
    case 'conference':
      return 1;
    case 'repository':
    case 'preprint':
      return 2;
    default:
      return undefined;
  }
}

// ─── Grading ─────────────────────────────────────────────────────────────

function downgrade(tier: GradeTier): GradeTier {
  if (tier === 'A') return 'B';
  if (tier === 'B') return 'C';
  return 'D';
}

// Pure and synchronous: given already-gathered signals, decide the tier.
// Retracted is an automatic D regardless of every other signal. Otherwise
// the source tier sets a base (1 -> A, 2 -> B, 3/4 -> C), downgraded one
// step for text that couldn't be verified against full text, and again if
// this citation's own claim(s) failed library_research's checkCitations
// pass - either signal being unknown (undefined) leaves the tier alone
// rather than treating "not checked" as a failure.
export function gradeFromSignals(signals: GradeSignals): GradeTier {
  if (signals.retracted) return 'D';
  let tier: GradeTier = signals.sourceTier === 1 ? 'A' : signals.sourceTier === 2 ? 'B' : 'C';
  if (!signals.fullTextVerified) tier = downgrade(tier);
  if (signals.chainSupported === false) tier = downgrade(tier);
  return tier;
}

export function gradeCitation(signals: GradeSignals): CitationGrade {
  return { tier: gradeFromSignals(signals), signals };
}

// Shared wording so a retracted citation reads identically whether it
// surfaces from library_answer's own grading pass or library_research's
// final union citations (both import this rather than inlining the
// string independently). The brief is explicit: "Retracted means tier D
// and a warning" - gradeFromSignals already sets the tier; this is that
// warning.
export function retractedWarning(n: number, title: string): string {
  return `citation [${n}] (${title}) is marked retracted`;
}

// ─── OpenAlex batched DOI enrichment ─────────────────────────────────────

const OPENALEX_BASE = 'https://api.openalex.org';
// OpenAlex's OR filter accepts up to 100 pipe-separated values; kept well
// under that (and under the brief's own per_page=50 example) since a
// single answer/report never carries more than a handful of DOI-bearing
// citations.
const OPENALEX_BATCH_SIZE = 50;

interface OAWorkGradeFields {
  doi?: string;
  is_retracted?: boolean;
  cited_by_count?: number;
  primary_location?: { source?: { type?: string } };
}
interface OAWorksGradeResponse {
  results?: OAWorkGradeFields[];
}

export interface OpenAlexGradeSignal {
  retracted: boolean;
  citationCount?: number;
  sourceType?: string;
}

export function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
}

// Keyed by the normalized (bare, lowercased) DOI so callers can look up a
// result with normalizeDoi(citation.doi) regardless of whether OpenAlex
// echoed it back as a bare DOI or a full https://doi.org/... URL.
export async function fetchOpenAlexGradeSignals(
  dois: string[],
): Promise<Map<string, OpenAlexGradeSignal>> {
  const result = new Map<string, OpenAlexGradeSignal>();
  const unique = [...new Set(dois.map(normalizeDoi).filter(Boolean))];
  if (unique.length === 0) return result;

  for (let i = 0; i < unique.length; i += OPENALEX_BATCH_SIZE) {
    const batch = unique.slice(i, i + OPENALEX_BATCH_SIZE);
    const filterValue = batch.map((d) => `https://doi.org/${d}`).join('|');
    try {
      const data = await fetchJSON<OAWorksGradeResponse>(
        `${OPENALEX_BASE}/works?filter=doi:${filterValue}&select=doi,is_retracted,cited_by_count,primary_location&per_page=${batch.length}&${authParam()}`,
      );
      for (const w of data.results ?? []) {
        if (!w.doi) continue;
        result.set(normalizeDoi(w.doi), {
          retracted: Boolean(w.is_retracted),
          citationCount: w.cited_by_count,
          sourceType: w.primary_location?.source?.type,
        });
      }
    } catch {
      // Best-effort: this batch's DOIs simply grade without OpenAlex
      // signals, same as a DOI OpenAlex has no record of at all.
    }
  }
  return result;
}

// ─── Orchestration ────────────────────────────────────────────────────────

export interface GradeCitationInput {
  n: number;
  source: string;
  id: string;
  cluster?: string;
  doi?: string;
  year?: number;
  fullTextVerified: boolean;
  chainSupported?: boolean;
}

function withoutUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// One batched OpenAlex call for every DOI-bearing input, plus one
// Semantic-Scholar lookup per semanticscholar-sourced input (that source
// has no DOI-keyed batch endpoint reused here; its citation counts are
// looked up by its own paperId instead - see s2CitationSignals). Returns a
// grade per citation number (Citation.n), so a caller can assign
// `citations[i].grade = grades.get(citations[i].n)`.
export async function gradeCitations(
  inputs: GradeCitationInput[],
): Promise<Map<number, CitationGrade>> {
  const dois = inputs.map((i) => i.doi).filter((d): d is string => Boolean(d));
  const openAlexByDoi = await fetchOpenAlexGradeSignals(dois);

  const s2ByN = new Map<number, { citationCount?: number; influentialCitationCount?: number }>();
  await Promise.all(
    inputs
      .filter((i) => i.source === 'semanticscholar')
      .map(async (i) => {
        const sig = await s2CitationSignals(i.id);
        if (sig) s2ByN.set(i.n, sig);
      }),
  );

  const grades = new Map<number, CitationGrade>();
  for (const input of inputs) {
    const oa = input.doi ? openAlexByDoi.get(normalizeDoi(input.doi)) : undefined;
    const s2 = s2ByN.get(input.n);

    let sourceTier = sourceTierFor(input.source, input.cluster);
    const refined = tierFromOpenAlexSourceType(oa?.sourceType);
    if (refined !== undefined) sourceTier = refined;

    const signals: GradeSignals = withoutUndefined({
      sourceTier,
      retracted: oa?.retracted,
      citationCount: oa?.citationCount ?? s2?.citationCount,
      influentialCitations: s2?.influentialCitationCount,
      year: input.year,
      fullTextVerified: input.fullTextVerified,
      chainSupported: input.chainSupported,
    });

    grades.set(input.n, gradeCitation(signals));
  }
  return grades;
}
