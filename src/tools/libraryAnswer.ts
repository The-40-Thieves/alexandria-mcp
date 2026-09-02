// THE-317: library_answer (Stage 9, task 9.1). Runs libraryAsk's routing
// and fan-out, fuses the per-source result lists with RRF, optionally
// reranks them with an LLM, reads the top full-text results, and asks the
// `synth` role for a cited answer. Every LLM call goes through
// src/utils/providers.ts; nothing here imports openai directly.
import { getAdapter } from '../sources/registry.js';
import type { LibraryResult } from '../types.js';
import { llmRerank, rrf } from '../utils/fuse.js';
import { pool, type RemoteServerConfig } from '../utils/mcpClientPool.js';
import { chatText, requireRoleForTool } from '../utils/providers.js';
import { type RouteItem, runAsk } from './libraryAsk.js';

const READ_CHAR_LIMIT = 6000;
const RERANK_POOL_CAP = 40;

export interface Citation {
  n: number;
  source: string;
  id: string;
  title: string;
  url?: string;
}

export interface LibraryAnswerOptions {
  maxSources?: number;
  resultsPerSource?: number;
  readTop?: number;
}

export interface LibraryAnswerResult {
  answer: string;
  citations: Citation[];
  results: Array<LibraryResult & { score: number }>;
  routing: RouteItem[];
}

interface KnowledgeHit {
  id?: string;
  title?: string;
  url?: string;
  snippet?: string;
  description?: string;
}

function parseKnowledgeHits(raw: { text: string; structured?: unknown }): KnowledgeHit[] {
  let data: unknown = raw.structured;
  if (data === undefined) {
    try {
      data = JSON.parse(raw.text);
    } catch {
      return [];
    }
  }
  if (Array.isArray(data)) return data as KnowledgeHit[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results as KnowledgeHit[];
    if (Array.isArray(obj.hits)) return obj.hits as KnowledgeHit[];
  }
  return [];
}

// Calls the optional external knowledge_search MCP tool
// (KNOWLEDGE_MCP_URL) and folds its hits in as one more ranked list for
// rrf(). Skipped silently (returns []) when the URL isn't set or the call
// fails for any reason; logged at debug (DEBUG=1) only.
async function fetchKnowledgeResults(query: string, limit: number): Promise<LibraryResult[]> {
  const url = process.env.KNOWLEDGE_MCP_URL;
  if (!url) return [];

  const token = process.env.KNOWLEDGE_MCP_TOKEN;
  const server: RemoteServerConfig = {
    name: 'knowledge',
    url,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  };

  try {
    const raw = await pool.call(server, 'knowledge_search', { query, limit });
    const hits = parseKnowledgeHits(raw);
    return hits.map((hit, i) => ({
      id: hit.id ?? String(i),
      source: 'knowledge',
      title: hit.title ?? '(untitled)',
      authors: [],
      hasFullText: false,
      description: hit.snippet ?? hit.description,
      url: hit.url,
    }));
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(
        `[library_answer] knowledge_search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }
}

interface ReadSource {
  item: LibraryResult;
  text: string;
}

// Reads the first `readTop` ranked results that claim hasFullText, skipping
// any whose read() turns out metadataOnly or empty (a source can say
// hasFullText: true at search time and still fail to produce text for a
// specific item, e.g. paywalled). Does not backfill past the initial
// readTop candidates.
async function readTopSources(ranked: LibraryResult[], readTop: number): Promise<ReadSource[]> {
  const candidates = ranked.filter((r) => r.hasFullText).slice(0, readTop);
  const sources: ReadSource[] = [];
  for (const item of candidates) {
    try {
      const result = await getAdapter(item.source).read(item.id);
      if (result.metadataOnly || !result.text) continue;
      sources.push({ item, text: result.text.slice(0, READ_CHAR_LIMIT) });
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(
          `[library_answer] read failed for ${item.source}:${item.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return sources;
}

function buildSourcesBlock(sources: ReadSource[]): string {
  return sources
    .map((s, i) => `[${i + 1}] ${s.item.title} (${s.item.source}:${s.item.id})\n${s.text}`)
    .join('\n\n---\n\n');
}

function buildSynthSystem(sourceCount: number): string {
  return `You are a research assistant answering a question using only the numbered sources provided below.

Rules:
- Every sentence that states a fact must end with one or more citation markers in the form [n], where n is a source number, e.g. "The API added rate limiting in 2025 [1][3]."
- If a claim cannot be supported by the sources, write "not found in the sources" instead of guessing.
- Only cite source numbers 1 through ${sourceCount}. Never invent a source number.
- Write in plain prose.`;
}

// Splits on sentence-ending punctuation followed by whitespace. Not a full
// sentence tokenizer, but adequate for finding citation markers per
// sentence in LLM prose.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CITATION_MARKER_RE = /\[(\d+)\]/g;

// Drops any sentence whose citation marker(s) reference a number outside
// 1..sourceCount, rather than failing the whole answer.
function dropDanglingCitations(answer: string, sourceCount: number): string {
  const kept = splitSentences(answer).filter((sentence) => {
    const nums = [...sentence.matchAll(CITATION_MARKER_RE)].map((m) => Number(m[1]));
    return nums.every((n) => n >= 1 && n <= sourceCount);
  });
  return kept.join(' ');
}

export async function libraryAnswer(
  query: string,
  opts: LibraryAnswerOptions = {},
): Promise<LibraryAnswerResult> {
  requireRoleForTool('library_answer', 'synth');

  const maxSources = opts.maxSources ?? 6;
  const resultsPerSource = opts.resultsPerSource ?? 5;
  const readTop = opts.readTop ?? 4;

  const { routing, perSource } = await runAsk(query, { maxSources, resultsPerSource });

  const lists = Object.values(perSource);
  const knowledgeResults = await fetchKnowledgeResults(query, resultsPerSource);
  if (knowledgeResults.length > 0) lists.push(knowledgeResults);

  const fused = rrf(lists);
  const rerankTop = Math.min(fused.length, RERANK_POOL_CAP) || 1;
  const ranked = (await llmRerank(query, fused, rerankTop)) as Array<
    LibraryResult & { score: number }
  >;

  const sources = await readTopSources(ranked, readTop);

  if (sources.length === 0) {
    return {
      answer: 'No full-text sources were found for this query; not found in the sources.',
      citations: [],
      results: ranked,
      routing,
    };
  }

  const system = buildSynthSystem(sources.length);
  const user = `${query}\n\nSources:\n${buildSourcesBlock(sources)}`;
  const rawAnswer = await chatText('synth', system, user);
  const answer = dropDanglingCitations(rawAnswer, sources.length);

  const citations: Citation[] = sources.map((s, i) => ({
    n: i + 1,
    source: s.item.source,
    id: s.item.id,
    title: s.item.title,
    url: s.item.url,
  }));

  return { answer, citations, results: ranked, routing };
}
