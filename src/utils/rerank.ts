// Task 10: cross-encoder rerank backends for library_answer's fused
// candidate pool (src/utils/fuse.ts's rrf()), plus the listwise LLM rerank
// that used to live in fuse.ts directly. All three backends share one
// entry point, rerank(), dispatched on config.ALEXANDRIA_RERANK (or an
// explicit override): 'llm' (a chat call over at most 20 shuffled
// candidates, the original behavior), 'cohere' (a true cross-encoder via
// the Cohere/Jina/Voyage/LiteLLM-shared "POST /rerank" request shape), and
// 'workers-ai' (Cloudflare's {query, contexts} shape for
// @cf/baai/bge-reranker-base). Every backend falls back to the input
// order, truncated to `top`, on any failure - no key configured, a
// network error, or a response that fails schema validation - exactly
// like the original llmRerank did.
import { z } from 'zod';
import { config } from '../config.ts';
import type { LibraryResult } from '../types.ts';
import { fetchJSON } from './http.ts';
import { chatJSON, roleConfig } from './providers.ts';

export type RerankBackend = 'off' | 'llm' | 'cohere' | 'workers-ai';

export interface RerankOptions {
  backend?: RerankBackend;
  top?: number;
}

// The 'llm' backend's own input cap, independent of how large a pool the
// caller hands rerank() (library_answer's ALEXANDRIA_RERANK_POOL, default
// 60): a listwise prompt over more than ~20 candidates both blows the
// prompt budget and is exactly the position-bias regime research/
// retrieval-sota.md section 1 warns against, hence the shuffle below.
const LLM_LISTWISE_CAP = 20;

// "title. description" (falling back to the title alone) is the same
// document text every backend below reranks against - short enough for a
// cross-encoder's per-document budget, and description is the only prose
// LibraryResult carries pre-full-text-read.
function documentText(item: LibraryResult): string {
  return item.description ? `${item.title}. ${item.description}` : item.title;
}

// ─── llm: listwise chat rerank (moved from fuse.ts) ────────────────────────

const RerankOrderSchema = z.array(z.number().int());

// Numbers each item 1..N (avoids id collisions across sources) and asks the
// `rerank` role for a JSON array of item numbers, most to least relevant.
function buildRerankPrompt(items: LibraryResult[]): string {
  const listing = items
    .map(
      (item, i) => `${i + 1}. ${item.title} (${item.source}${item.year ? `, ${item.year}` : ''})`,
    )
    .join('\n');
  return `You are a search result reranker. Given a query and a numbered list of candidate results, decide which are most relevant.

Return JSON only: an array of the item numbers, most relevant first, e.g. [3, 1, 5, 2, 4]. Include every number exactly once.

Candidates:
${listing}`;
}

// Fisher-Yates over an injectable RNG (defaults to Math.random) so the
// listwise prompt's input order - and therefore any position bias in the
// model's answer - isn't just whatever order RRF happened to produce.
export function shuffleWithRng<T>(items: readonly T[], rng: () => number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Test-only override for the shuffle's RNG (same pattern as providers.ts's
// openaiBaseUrlOverride): production leaves this at Math.random; a test
// swaps in a seeded PRNG so the resulting shuffle - and the exact prompt
// sent to the fake chat server - is deterministic instead of "it changed
// order, trust me".
export const shuffleRngOverride: { value: () => number } = { value: Math.random };

// Listwise rerank via the `rerank` role, over at most the top
// LLM_LISTWISE_CAP of `items` (already RRF-ordered), shuffled before the
// prompt is built. Items past that cap keep their incoming relative order
// and are appended after the reordered head. Falls back to the input
// order (truncated to `top`) on any failure: no key configured, a network
// error, or a response that fails schema validation twice.
async function llmListwiseRerank(
  query: string,
  items: LibraryResult[],
  top: number,
): Promise<LibraryResult[]> {
  if (items.length === 0) return [];

  const head = items.slice(0, LLM_LISTWISE_CAP);
  const tail = items.slice(LLM_LISTWISE_CAP);
  const shuffled = shuffleWithRng(head, shuffleRngOverride.value);

  try {
    const order = await chatJSON('rerank', buildRerankPrompt(shuffled), query, RerankOrderSchema);
    const used = new Set<number>();
    const ordered: LibraryResult[] = [];
    for (const n of order) {
      const idx = n - 1;
      if (idx >= 0 && idx < shuffled.length && !used.has(idx)) {
        used.add(idx);
        ordered.push(shuffled[idx]);
      }
    }
    for (let i = 0; i < shuffled.length; i++) {
      if (!used.has(i)) ordered.push(shuffled[i]);
    }
    return [...ordered, ...tail].slice(0, top);
  } catch {
    return items.slice(0, top);
  }
}

// ─── cohere: cross-encoder via the Cohere/Jina/Voyage/LiteLLM request shape ─

// https://docs.cohere.com/reference/rerank: request {model, query,
// documents, top_n}, response {results: [{index, relevance_score}]}. Jina,
// Voyage, and a LiteLLM gateway's own /rerank all accept the same shape.
const CohereRerankResponseSchema = z.object({
  results: z.array(z.object({ index: z.number().int(), relevance_score: z.number() })),
});

async function cohereRerank(
  query: string,
  items: LibraryResult[],
  top: number,
): Promise<LibraryResult[]> {
  if (items.length === 0) return [];
  const roleCfg = roleConfig('rerank');
  if (!roleCfg.apiKey) return items.slice(0, top);

  try {
    const url = `${roleCfg.baseURL.replace(/\/+$/, '')}/rerank`;
    const response = await fetchJSON<unknown>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${roleCfg.apiKey}`,
      },
      body: JSON.stringify({
        model: roleCfg.model,
        query,
        documents: items.map(documentText),
        top_n: Math.min(top, items.length),
      }),
    });
    const parsed = CohereRerankResponseSchema.parse(response);
    return parsed.results
      .filter((r) => r.index >= 0 && r.index < items.length)
      .map((r) => items[r.index])
      .slice(0, top);
  } catch {
    return items.slice(0, top);
  }
}

// ─── workers-ai: Cloudflare bge-reranker-base's {query, contexts} shape ────

// https://developers.cloudflare.com/workers-ai/models/bge-reranker-base:
// request {query, contexts: [{text}], top_k}, response envelope
// {result: {response: [{id, score}]}, success, errors, messages} - `id` is
// the index into `contexts`, and (unlike Cohere) the array isn't
// guaranteed sorted by score, so this backend sorts it itself.
// ALEXANDRIA_RERANK_BASE_URL is the full per-account model run URL for
// this backend (https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/
// @cf/baai/bge-reranker-base) - posted to directly, no path suffix.
const WorkersAiRerankResponseSchema = z.object({
  result: z.object({
    response: z.array(z.object({ id: z.number().int(), score: z.number() })),
  }),
});

async function workersAiRerank(
  query: string,
  items: LibraryResult[],
  top: number,
): Promise<LibraryResult[]> {
  if (items.length === 0) return [];
  const roleCfg = roleConfig('rerank');
  if (!roleCfg.apiKey) return items.slice(0, top);

  try {
    const response = await fetchJSON<unknown>(roleCfg.baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${roleCfg.apiKey}`,
      },
      body: JSON.stringify({
        query,
        contexts: items.map((item) => ({ text: documentText(item) })),
        top_k: Math.min(top, items.length),
      }),
    });
    const parsed = WorkersAiRerankResponseSchema.parse(response);
    const ranked = [...parsed.result.response].sort((a, b) => b.score - a.score);
    return ranked
      .filter((r) => r.id >= 0 && r.id < items.length)
      .map((r) => items[r.id])
      .slice(0, top);
  } catch {
    return items.slice(0, top);
  }
}

// ─── entry point ────────────────────────────────────────────────────────────

// Dispatches to whichever backend is selected (opts.backend, falling back
// to config.ALEXANDRIA_RERANK, falling back to 'off'). 'off' - and any
// unrecognized/unset value - keeps the input order, truncated to `top`.
export async function rerank(
  query: string,
  items: LibraryResult[],
  opts: RerankOptions = {},
): Promise<LibraryResult[]> {
  const backend = opts.backend ?? config.ALEXANDRIA_RERANK ?? 'off';
  const top = opts.top ?? items.length;

  switch (backend) {
    case 'llm':
      return llmListwiseRerank(query, items, top);
    case 'cohere':
      return cohereRerank(query, items, top);
    case 'workers-ai':
      return workersAiRerank(query, items, top);
    default:
      return items.slice(0, top);
  }
}
