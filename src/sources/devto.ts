// DEV Community (dev.to). A single-token query uses the tag-filtered
// articles endpoint (a real, working search-by-topic). A multi-token query
// uses the site's internal full-text search endpoint
// (/search/feed_content); as of 2026-09-01 that endpoint returns an empty
// result for every query tried (curl evidence in the task report), so a
// multi-token search may currently return [] until dev.to's backend
// changes; the tag path is unaffected. No API key required.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://dev.to/api';

interface DevtoArticle {
  id: number;
  title: string;
  description?: string;
  user?: { name?: string };
  published_at?: string;
  url: string;
}

interface DevtoFeedResult {
  id: number;
  title: string;
  path?: string;
  user?: { name?: string };
  published_at_int?: number;
}

interface DevtoFeedResponse {
  result: DevtoFeedResult[];
}

function yearOf(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const year = new Date(dateStr).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeDevtoArticle(a: DevtoArticle): LibraryResult {
  return {
    id: String(a.id),
    source: 'devto',
    title: a.title,
    authors: a.user?.name ? [a.user.name] : [],
    year: yearOf(a.published_at),
    hasFullText: Boolean(a.description),
    description: a.description,
    published: a.published_at,
    url: a.url,
  };
}

export function normalizeDevtoFeedResult(r: DevtoFeedResult): LibraryResult {
  const published = r.published_at_int
    ? new Date(r.published_at_int * 1000).toISOString()
    : undefined;
  return {
    id: String(r.id),
    source: 'devto',
    title: r.title,
    authors: r.user?.name ? [r.user.name] : [],
    year: r.published_at_int ? new Date(r.published_at_int * 1000).getFullYear() : undefined,
    hasFullText: false,
    published,
    url: r.path ? `https://dev.to${r.path}` : undefined,
  };
}

export async function devtoSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const trimmed = query.trim();
  const isSingleToken = trimmed.length > 0 && !/\s/.test(trimmed);
  if (isSingleToken) {
    const articles = await fetchJSON<DevtoArticle[]>(
      `${BASE}/articles?tag=${encodeURIComponent(trimmed)}&per_page=${limit}`,
    );
    return articles.map(normalizeDevtoArticle);
  }
  const params = new URLSearchParams({
    search_fields: trimmed,
    per_page: String(limit),
    class_name: 'Article',
  });
  const data = await fetchJSON<DevtoFeedResponse>(
    `https://dev.to/search/feed_content?${params.toString()}`,
  );
  return (data.result ?? []).map(normalizeDevtoFeedResult);
}

export async function devtoRead(id: string): Promise<ReadResult> {
  const raw = await fetchJSON<DevtoArticle & { body_markdown?: string }>(
    `${BASE}/articles/${encodeURIComponent(id)}`,
  );
  return {
    title: raw.title,
    authors: raw.user?.name ? [raw.user.name] : [],
    year: yearOf(raw.published_at),
    ...truncateText(raw.body_markdown || raw.description || `No content for article ${id}.`),
  };
}

register('devto', {
  description:
    'DEV Community (dev.to) articles. A single-word query filters by tag; a multi-word query uses the site search endpoint, which returns no results for any query as of 2026-09-01 (an upstream issue, see the task report). No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'realtime',
  homepage: 'https://dev.to',
  verifiedAt: '2026-09-01',
  search: devtoSearch,
  read: devtoRead,
});
