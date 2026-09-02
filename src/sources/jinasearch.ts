// Jina AI Search (s.jina.ai): web search returning clean, LLM-friendly
// per-result text (no separate fetch needed to see what a hit is about).
// Distinct from src/sources/mcp/jina.ts, which delegates to Jina's hosted
// MCP server; this one speaks the s.jina.ai HTTP API directly. Requires
// JINA_API_KEY, matching the reasoning in the task brief: the anonymous tier
// is capped at 20 RPM shared across every caller of s.jina.ai, so this stays
// hidden without a key rather than silently drawing on that shared budget.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { fetchAsText } from '../web/fetchTier.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://s.jina.ai';

interface JinaSearchHit {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
  date?: string;
}

interface JinaSearchResponse {
  data?: JinaSearchHit[];
}

function key(): string {
  const k = process.env.JINA_API_KEY;
  if (!k) throw new Error('jinasearch requires JINA_API_KEY');
  return k;
}

function yearOf(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const year = new Date(dateStr).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeJinaSearch(item: JinaSearchHit): LibraryResult | null {
  if (!item.url) return null;
  return {
    id: item.url,
    source: 'jinasearch',
    title: item.title || item.url,
    authors: [],
    year: yearOf(item.date),
    hasFullText: false,
    description: item.description ?? item.content,
    published: item.date,
    url: item.url,
  };
}

export async function jinasearchSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<JinaSearchResponse>(`${BASE}/${encodeURIComponent(query)}`, {
    headers: {
      Accept: 'application/json',
      'X-Respond-With': 'no-content',
      Authorization: `Bearer ${key()}`,
    },
  });
  const results: LibraryResult[] = [];
  for (const item of data.data ?? []) {
    const normalized = normalizeJinaSearch(item);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

export async function jinasearchRead(id: string): Promise<ReadResult> {
  const page = await fetchAsText(id);
  return { title: page.title, authors: [], externalUrl: id, ...truncateText(page.text) };
}

register('jinasearch', {
  description:
    'Jina AI Search (s.jina.ai): web search returning clean per-result text. Requires JINA_API_KEY; hidden without it to respect the 20 RPM anonymous cap shared across every caller. read() fetches and extracts the linked page.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'web',
  freshness: 'realtime',
  homepage: 'https://jina.ai/reader',
  timeoutMs: 30000,
  auth: { type: 'bearer', env: 'JINA_API_KEY' },
  search: jinasearchSearch,
  read: jinasearchRead,
});
