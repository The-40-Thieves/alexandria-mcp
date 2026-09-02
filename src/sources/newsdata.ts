// newsdata.io: real-time global news search. Requires NEWSDATA_API_KEY. A
// custom register() rather than defineRest(): read() is metadata only until
// the fetchTier web-fetch tier lands in Stage 6 (the same TODO convention
// used by mdn.ts, nhk.ts and kinds/rss.ts), since newsdata articles are
// external web pages, not a JSON API.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const BASE = 'https://newsdata.io/api/1/latest';

interface NewsdataArticle {
  article_id: string;
  title: string;
  pubDate?: string;
  link?: string;
  description?: string;
}

interface NewsdataResponse {
  results?: NewsdataArticle[];
}

function key(): string {
  const k = process.env.NEWSDATA_API_KEY;
  if (!k) throw new Error('newsdata requires NEWSDATA_API_KEY');
  return k;
}

function yearOf(pubDate: string | undefined): number | undefined {
  if (!pubDate) return undefined;
  const year = new Date(pubDate).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeNewsdata(item: NewsdataArticle): LibraryResult | null {
  if (!item.article_id) return null;
  return {
    id: item.article_id,
    source: 'newsdata',
    title: item.title || item.article_id,
    authors: [],
    year: yearOf(item.pubDate),
    hasFullText: false,
    description: item.description,
    published: item.pubDate,
    url: item.link,
  };
}

export async function newsdataSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<NewsdataResponse>(
    `${BASE}?q=${encodeURIComponent(query)}&language=en&apikey=${key()}`,
  );
  const results: LibraryResult[] = [];
  for (const item of data.results ?? []) {
    const normalized = normalizeNewsdata(item);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

// Stays metadata-only, and not for want of a fetch tier. A newsdata result's
// id is the opaque `article_id`, not a URL: the article link is carried in
// the result's `url` field but is not what read() is handed, and the free
// tier's article-by-id lookup is not available, so there is nothing here to
// fetch. Callers wanting the body should pass the result's `url` to the
// webfetch source.
export async function newsdataRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    note: "newsdata ids are opaque article ids, not URLs; pass the result's url to the webfetch source for the article body.",
  };
}

register('newsdata', {
  description: 'newsdata.io: real-time global news article search. Requires free NEWSDATA_API_KEY.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'news_global',
  freshness: 'realtime',
  homepage: 'https://newsdata.io',
  auth: { type: 'query', env: 'NEWSDATA_API_KEY', param: 'apikey' },
  pacing: { dailyCap: 180 },
  search: newsdataSearch,
  read: newsdataRead,
});
