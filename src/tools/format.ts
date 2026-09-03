// response_format: "concise" | "detailed" (task 1, brief 05 / vault idea
// 10). Concise trims a tool's payload to the high-signal fields an agent
// usually needs; detailed returns the tool's full payload unchanged. One
// implementation shared by every response_format-bearing tool
// (library_ask, library_search, library_answer, library_research) rather
// than four ad hoc reductions in src/index.ts's handlers.
//
// src/index.ts's outputSchema for each of these tools is the detailed
// shape with every concise-only-absent field made optional, since the SDK
// validates structuredContent against that one schema regardless of which
// format a given call produced.
import type { LibraryResult } from '../types.ts';
import type { Citation } from './libraryAnswer.ts';
import type { AskResult } from './libraryAsk.ts';

export type ResponseFormat = 'concise' | 'detailed';

export interface ConciseResultRow {
  title: string;
  source: string;
  id: string;
  hasFullText: boolean;
  year?: number;
  url?: string;
}

function toConciseRow(r: LibraryResult): ConciseResultRow {
  const row: ConciseResultRow = {
    title: r.title,
    source: r.source,
    id: r.id,
    hasFullText: r.hasFullText,
  };
  if (r.year !== undefined) row.year = r.year;
  if (r.url !== undefined) row.url = r.url;
  return row;
}

export interface ConciseAskResult {
  query: string;
  intent: string;
  sources_searched: string[];
  total_results: number;
  results: ConciseResultRow[];
  routing: string[];
  errors: Array<{ source: string; error: string }>;
}

interface AnswerLike {
  answer: string;
  citations: Citation[];
}

export interface ConciseAnswerLike {
  answer: string;
  citations: Citation[];
}

interface ResearchLike {
  report: string;
  citations: Citation[];
}

export interface ConciseResearchLike {
  report: string;
  citations: Citation[];
}

export type FormatKind = 'ask' | 'search' | 'answer' | 'research';

export function formatResult(
  kind: 'ask',
  payload: AskResult,
  format: ResponseFormat,
): AskResult | ConciseAskResult;
export function formatResult(
  kind: 'search',
  payload: { results: LibraryResult[] },
  format: ResponseFormat,
): { results: LibraryResult[] | ConciseResultRow[] };
export function formatResult<T extends AnswerLike>(
  kind: 'answer',
  payload: T,
  format: ResponseFormat,
): T | ConciseAnswerLike;
export function formatResult<T extends ResearchLike>(
  kind: 'research',
  payload: T,
  format: ResponseFormat,
): T | ConciseResearchLike;
export function formatResult(kind: FormatKind, payload: unknown, format: ResponseFormat): unknown {
  if (format === 'detailed') return payload;

  switch (kind) {
    case 'ask': {
      const p = payload as AskResult;
      const concise: ConciseAskResult = {
        query: p.query,
        intent: p.intent,
        sources_searched: p.sources_searched,
        total_results: p.total_results,
        results: p.results.map(toConciseRow),
        routing: p.routing.map((r) => r.source),
        errors: p.errors,
      };
      return concise;
    }
    case 'search': {
      const p = payload as { results: LibraryResult[] };
      return { results: p.results.map(toConciseRow) };
    }
    case 'answer': {
      const p = payload as AnswerLike;
      const concise: ConciseAnswerLike = { answer: p.answer, citations: p.citations };
      return concise;
    }
    case 'research': {
      const p = payload as ResearchLike;
      const concise: ConciseResearchLike = { report: p.report, citations: p.citations };
      return concise;
    }
    default:
      return payload;
  }
}
