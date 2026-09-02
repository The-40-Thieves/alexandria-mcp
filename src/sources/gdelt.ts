// GDELT: the Global Database of Events, Language, and Tone. Full-text news
// article search across GDELT's worldwide monitoring. No API key required.
// GDELT asks callers to space requests at least 5s apart; timeoutMs is 45s
// because the doc API itself can be slow to answer.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const TIMEOUT_MS = 45000;

interface GdeltArticle {
  url: string;
  title: string;
  seendate?: string;
  domain?: string;
  language?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

function yearOf(seendate: string | undefined): number | undefined {
  // seendate is "YYYYMMDDTHHMMSSZ"
  if (!seendate || seendate.length < 4) return undefined;
  const year = Number(seendate.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeGdelt(article: GdeltArticle): LibraryResult | null {
  if (!article.url) return null;
  return {
    id: article.url,
    source: 'gdelt',
    title: article.title || article.url,
    authors: [],
    year: yearOf(article.seendate),
    hasFullText: false,
    description: article.domain,
    url: article.url,
  };
}

export async function gdeltSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<GdeltResponse>(
    `${BASE}?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${limit}&format=json`,
    {},
    TIMEOUT_MS,
  );
  const results: LibraryResult[] = [];
  for (const article of data.articles ?? []) {
    const normalized = normalizeGdelt(article);
    if (normalized) results.push(normalized);
  }
  return results;
}

// TODO(stage-6): fetchTier. Once the web fetch tier lands, read(id) should
// retrieve and extract the article body at the url instead of metadata
// only, the same convention as kinds/rss.ts and nhk.ts.
export async function gdeltRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    externalUrl: id,
    note: 'Full-text fetch for GDELT arrives in a later stage; this is metadata only.',
  };
}

register('gdelt', {
  description:
    'GDELT: the Global Database of Events, Language, and Tone. Full-text search across worldwide news coverage monitored by GDELT. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'news_global',
  freshness: 'realtime',
  homepage: 'https://www.gdeltproject.org',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  pacing: { minIntervalMs: 5000 },
  search: gdeltSearch,
  read: gdeltRead,
});
