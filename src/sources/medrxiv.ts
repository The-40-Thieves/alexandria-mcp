// medRxiv: clinical/health-sciences preprints, same api.biorxiv.org service
// as biorxiv.ts with server=medrxiv - same no-search-API caveat (see
// biorxivSearch's comment), so this mirrors that file's windowed
// client-side scan rather than defineRest.
import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.biorxiv.org';

interface MedrxivPaper {
  doi: string;
  title: string;
  authors: string;
  date: string;
  category: string;
  abstract: string;
}

interface MedrxivResponse {
  messages?: Array<{ status: string; total?: number }>;
  collection: MedrxivPaper[];
}

function toResult(p: MedrxivPaper): LibraryResult {
  return {
    id: p.doi,
    source: 'medrxiv' as const,
    title: p.title,
    authors: p.authors ? p.authors.split('; ') : [],
    year: p.date ? parseInt(p.date.substring(0, 4), 10) : undefined,
    subjects: p.category ? [p.category] : [],
    language: 'en',
    hasFullText: Boolean(p.abstract),
    previewUrl: `https://www.medrxiv.org/content/${p.doi}`,
    description: p.abstract?.substring(0, 300),
  };
}

export function matchesQuery(p: MedrxivPaper, terms: string[]): boolean {
  const haystack = `${p.title} ${p.abstract ?? ''}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

const PAGE_SIZE = 30; // medRxiv's /details endpoint pages at 30/request
const MAX_PAGES = 5; // cap client-side filtering cost (up to 150 papers scanned)
const WINDOW_DAYS = 7;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// medRxiv has no free-text search API (same as bioRxiv); the only listing
// endpoint is a date-window details feed. Page through the last 7 days and
// filter client-side by title/abstract substring match; this can miss
// matches older than the window or past MAX_PAGES, the same inherent
// limitation as biorxivSearch.
export async function medrxivSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const results: LibraryResult[] = [];

  for (let page = 0; page < MAX_PAGES && results.length < limit; page++) {
    const data = await fetchJSON<MedrxivResponse>(
      `${BASE}/details/medrxiv/${isoDate(from)}/${isoDate(to)}/${page * PAGE_SIZE}`,
    );
    const collection = data.collection ?? [];
    for (const p of collection) {
      if (matchesQuery(p, terms)) results.push(toResult(p));
      if (results.length >= limit) break;
    }
    if (collection.length < PAGE_SIZE) break; // no more pages
  }

  return results;
}

export async function medrxivRead(doi: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  doi: string;
}> {
  const data = await fetchJSON<MedrxivResponse>(
    `${BASE}/details/medrxiv/${encodeURIComponent(doi)}/na/json`,
  );
  const p = data.collection?.[0];
  if (!p) throw new Error(`medRxiv paper not found: ${doi}`);
  return {
    text: p.abstract || `No abstract available for ${doi}`,
    title: p.title,
    authors: p.authors ? p.authors.split('; ') : [],
    year: p.date ? parseInt(p.date.substring(0, 4), 10) : undefined,
    language: 'en',
    doi,
  };
}

register('medrxiv', {
  description:
    'medRxiv: clinical and health sciences preprints. No API key required. medRxiv has no free-text search API; search() lists the last 7 days of postings (paged, capped) and filters client-side by title/abstract match, so it can miss older matches or ones past the scan cap. Use read(doi) directly when you already have a DOI.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'science',
  freshness: 'daily',
  homepage: 'https://www.medrxiv.org',
  verifiedAt: '2026-09-03',
  timeoutMs: 30000, // client-side scan can page through up to MAX_PAGES requests
  search: medrxivSearch,
  async read(id) {
    const raw = await medrxivRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
