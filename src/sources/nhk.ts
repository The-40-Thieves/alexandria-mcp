// NHK World News. The upstream endpoint is a single JSON document (all
// current headlines, no query parameter), so search() fetches it once per
// call and filters client-side, the same token-match convention as the RSS
// kind, rather than going through defineRest() (which expects a real
// per-query search API).
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const URL = 'https://www3.nhk.or.jp/nhkworld/data/en/news/all.json';
const ORIGIN = 'https://www3.nhk.or.jp';
const TIMEOUT_MS = 20000;

interface NhkItem {
  id: string;
  page_url: string;
  title: string;
  description?: string;
  updated_at?: string;
}

interface NhkResponse {
  data: NhkItem[];
}

function toUrl(pageUrl: string): string {
  return pageUrl.startsWith('http') ? pageUrl : `${ORIGIN}${pageUrl}`;
}

function matchesQuery(item: NhkItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${item.title} ${item.description ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizeNhk(data: NhkResponse): LibraryResult[] {
  return (data.data ?? []).map((item) => {
    const url = toUrl(item.page_url);
    return {
      id: url,
      source: 'nhk',
      title: item.title,
      authors: [],
      hasFullText: false,
      description: item.description,
      published: item.updated_at ? new Date(Number(item.updated_at)).toISOString() : undefined,
      url,
    };
  });
}

export async function nhkSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<NhkResponse>(URL, {}, TIMEOUT_MS);
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = (data.data ?? []).filter((item) => matchesQuery(item, tokens));
  matched.sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0));
  return normalizeNhk({ data: matched.slice(0, limit) });
}

// TODO(stage-6): fetchTier
export async function nhkRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    externalUrl: id,
    note: 'Full-text fetch for NHK arrives in a later stage; this is metadata only.',
  };
}

register('nhk', {
  description:
    'NHK World News: Japanese public broadcaster, English-language world news headlines.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'news_regional',
  freshness: 'realtime',
  homepage: 'https://www3.nhk.or.jp/nhkworld',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: nhkSearch,
  read: nhkRead,
});
