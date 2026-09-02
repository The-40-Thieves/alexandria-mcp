// THE-317: Reciprocal Rank Fusion and an optional listwise LLM rerank for
// library_answer/library_research (Stage 9). Fuses one ranked LibraryResult
// list per source/engine into a single ranked list, then dedupes near
// duplicates (the same work returned under slightly different titles by two
// sources) before anything gets read or cited.
import { z } from 'zod';
import { config } from '../config.ts';
import type { LibraryResult } from '../types.ts';
import { chatJSON } from './providers.ts';

export interface FusedResult extends LibraryResult {
  score: number;
}

// Lowercase, strip punctuation, first 80 chars: the same shape libraryAsk.ts
// already uses for its own flat dedupe, just factored out here so rrf() can
// dedupe *after* scoring instead of on first-seen order.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 80);
}

// Reciprocal Rank Fusion: each list contributes 1/(k+rank) to an item's
// score, keyed on `${source}:${id}` so the same item ranked in two lists
// (e.g. present in both a source's own search results and a rerouted
// knowledge_search hit) accumulates rather than being counted twice.
// Sorted descending by score, then deduped by normalized title, keeping the
// highest-scoring representative of each title.
export function rrf(lists: LibraryResult[][], k = 60): FusedResult[] {
  const scores = new Map<string, number>();
  const items = new Map<string, LibraryResult>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const key = `${item.source}:${item.id}`;
      const rank = index + 1;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank));
      if (!items.has(key)) items.set(key, item);
    });
  }

  const scored: FusedResult[] = [...items.entries()].map(([key, item]) => ({
    ...item,
    score: scores.get(key) ?? 0,
  }));
  scored.sort((a, b) => b.score - a.score);

  const seenTitles = new Set<string>();
  const deduped: FusedResult[] = [];
  for (const item of scored) {
    const titleKey = normalizeTitle(item.title);
    if (titleKey && seenTitles.has(titleKey)) continue;
    if (titleKey) seenTitles.add(titleKey);
    deduped.push(item);
  }
  return deduped;
}

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

// Listwise rerank via the `rerank` role. Off by default; on only when
// ALEXANDRIA_RERANK=llm. Falls back to the input order (truncated to `top`)
// on any failure: no key configured, a network error, or a response that
// fails schema validation twice.
export async function llmRerank(
  query: string,
  items: LibraryResult[],
  top = 10,
): Promise<LibraryResult[]> {
  if (config.ALEXANDRIA_RERANK !== 'llm' || items.length === 0) {
    return items.slice(0, top);
  }

  try {
    const order = await chatJSON('rerank', buildRerankPrompt(items), query, RerankOrderSchema);
    const used = new Set<number>();
    const ordered: LibraryResult[] = [];
    for (const n of order) {
      const idx = n - 1;
      if (idx >= 0 && idx < items.length && !used.has(idx)) {
        used.add(idx);
        ordered.push(items[idx]);
      }
    }
    for (let i = 0; i < items.length; i++) {
      if (!used.has(i)) ordered.push(items[i]);
    }
    return ordered.slice(0, top);
  } catch {
    return items.slice(0, top);
  }
}
