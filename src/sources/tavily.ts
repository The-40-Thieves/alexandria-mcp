// Tavily: a web search API purpose-built for LLM agents and RAG pipelines
// (results come pre-summarized for relevance). Requires TAVILY_API_KEY;
// hidden without it. Custom register() rather than defineRest() because
// read() goes through the web fetch tier (fetchAsText), not a second JSON
// API call.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

const SEARCH_URL = 'https://api.tavily.com/search';

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

function key(): string {
  const k = process.env.TAVILY_API_KEY;
  if (!k) throw new Error('tavily requires TAVILY_API_KEY');
  return k;
}

function yearOf(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const year = new Date(dateStr).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeTavily(item: TavilyResult): LibraryResult | null {
  if (!item.url) return null;
  return {
    id: item.url,
    source: 'tavily',
    title: item.title || item.url,
    authors: [],
    year: yearOf(item.published_date),
    hasFullText: false,
    description: item.content,
    published: item.published_date,
    url: item.url,
  };
}

export async function tavilySearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<TavilyResponse>(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({ query, max_results: limit, include_raw_content: false }),
  });
  const results: LibraryResult[] = [];
  for (const item of data.results ?? []) {
    const normalized = normalizeTavily(item);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

export async function tavilyRead(id: string): Promise<ReadResult> {
  const page = await fetchAsText(id);
  return { title: page.title, authors: [], externalUrl: id, ...truncateText(page.text) };
}

register('tavily', {
  description:
    'Tavily: a web search API purpose-built for LLM agents and RAG pipelines, with results pre-summarized for relevance. Requires TAVILY_API_KEY; hidden without it. read() fetches and extracts the linked page.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'web',
  freshness: 'realtime',
  homepage: 'https://tavily.com',
  timeoutMs: 30000,
  auth: { type: 'bearer', env: 'TAVILY_API_KEY' },
  search: tavilySearch,
  read: tavilyRead,
});
