// THE-317: Reciprocal Rank Fusion for library_answer/library_research
// (Stage 9). Fuses one ranked LibraryResult list per source/engine into a
// single ranked list, then dedupes near duplicates (the same work returned
// under slightly different titles by two sources) before anything gets
// read or cited. The optional rerank pass that used to live here (a
// listwise LLM call) moved to src/utils/rerank.ts in Task 10, which also
// adds cross-encoder backends behind the same rerank() entry point.
import type { LibraryResult } from '../types.ts';

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
