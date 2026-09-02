// Google News RSS search. Unlike the fixed-feed sources in src/sources/feeds/,
// the search URL is built per query, so this registers directly instead of
// going through defineRssSource()'s single-feed FeedConfig.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { parseFeedItems } from './kinds/rss.ts';
import { register } from './registry.ts';

const TIMEOUT_MS = 20000;

function searchUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function toTime(published?: string): number {
  if (!published) return 0;
  const t = Date.parse(published);
  return Number.isNaN(t) ? 0 : t;
}

export async function googlenewsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const body = await fetchText(searchUrl(query), {}, TIMEOUT_MS);
  const items = parseFeedItems(body);
  items.sort((a, b) => toTime(b.published) - toTime(a.published));
  return items.slice(0, limit).map((item) => {
    const id = item.link || item.id;
    return {
      id,
      source: 'googlenews',
      title: item.title || id,
      authors: item.authors,
      hasFullText: false,
      description: item.summary,
      published: item.published,
      url: item.link || undefined,
    };
  });
}

// Google News RSS links (news.google.com/rss/articles/...) do not resolve
// to the publisher's article via an ordinary HTTP redirect: a plain GET
// with redirects followed returns HTTP 200 with an empty body at the same
// news.google.com URL (verified live 2026-09-02). The actual publisher URL
// is embedded in an opaque token that Google's client-side JS decodes
// through an undocumented batchexecute RPC call; every third-party
// decoder for this works by reverse-engineering that call. That's a
// meaningfully different (and fragile) integration than the fetch tier
// this stage adds, so googlenews stays metadata-only rather than adding it.
export async function googlenewsRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    externalUrl: id,
    note: 'Google News links redirect through Google; full-text fetch is not available for this source.',
  };
}

register('googlenews', {
  description: 'Google News: search-by-query RSS aggregator across global news sources.',
  supportsIngest: false,
  kind: 'rss',
  cluster: 'news_global',
  freshness: 'realtime',
  homepage: 'https://news.google.com',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: googlenewsSearch,
  read: googlenewsRead,
});
