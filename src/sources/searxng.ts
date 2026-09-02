// SearXNG: a self-hosted metasearch engine that fans a query out across many
// upstream engines and returns one aggregated result list. Requires
// SEARXNG_URL (a deployment-specific instance URL, e.g. a tailnet address);
// `hidden` is set explicitly here since there's no key to gate on, just a
// URL, which registry.register()'s default auth-based hidden check doesn't
// cover (the same pattern congress.ts and regulations.ts use).
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { fetchAsText } from '../web/fetchTier.js';
import { register, truncateText } from './registry.js';

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

function baseUrl(): string {
  const url = process.env.SEARXNG_URL;
  if (!url) throw new Error('searxng requires the SEARXNG_URL environment variable');
  return url.replace(/\/$/, '');
}

function yearOf(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const year = new Date(dateStr).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeSearxng(item: SearxngResult): LibraryResult | null {
  if (!item.url) return null;
  return {
    id: item.url,
    source: 'searxng',
    title: item.title || item.url,
    authors: [],
    year: yearOf(item.publishedDate),
    hasFullText: false,
    description: item.content,
    published: item.publishedDate,
    url: item.url,
  };
}

export async function searxngSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', categories: 'general' });
  const data = await fetchJSON<SearxngResponse>(`${baseUrl()}/search?${params}`);
  const results: LibraryResult[] = [];
  for (const item of data.results ?? []) {
    const normalized = normalizeSearxng(item);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

export async function searxngRead(id: string): Promise<ReadResult> {
  const page = await fetchAsText(id);
  return { title: page.title, authors: [], externalUrl: id, ...truncateText(page.text) };
}

register('searxng', {
  description:
    'SearXNG: a self-hosted, privacy-respecting metasearch engine aggregating results across many upstream search engines. Requires SEARXNG_URL (a deployment-specific instance URL); hidden without it. read() fetches and extracts the linked page.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'web',
  freshness: 'realtime',
  homepage: 'https://docs.searxng.org',
  timeoutMs: 30000,
  hidden: !process.env.SEARXNG_URL,
  search: searxngSearch,
  read: searxngRead,
});
