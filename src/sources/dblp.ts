// DBLP (dblp.org): venue-precise computer science bibliography. No API key
// required; dblp's own FAQ asks for "1-2 requests per second", paced here
// at 1 rps. search() is a single JSON fetch, but read() fetches a
// record's BibTeX (dblp has no per-record JSON endpoint - verified live
// 2026-09-03, `/rec/{key}.json` 404s while `/rec/{key}.bib` returns the
// citation), a plain-text fetch, so this is a hand-written register()
// rather than defineRest.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const SEARCH_URL = 'https://dblp.org/search/publ/api';
const REC_BASE = 'https://dblp.org/rec';

interface DblpAuthor {
  text?: string;
}
interface DblpInfo {
  title?: string;
  authors?: { author?: DblpAuthor | DblpAuthor[] };
  venue?: string;
  year?: string;
  doi?: string;
  ee?: string;
  url?: string;
  key: string;
}
interface DblpHit {
  info: DblpInfo;
}
interface DblpSearchResponse {
  result?: { hits?: { hit?: DblpHit[] } };
}

// dblp's XML-to-JSON conversion collapses a single-author `author` list to
// a bare object rather than a one-element array.
function authorNames(authors?: { author?: DblpAuthor | DblpAuthor[] }): string[] {
  const raw = authors?.author;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((a) => a.text).filter((t): t is string => Boolean(t));
}

export function normalizeDblpHit(hit: DblpHit): LibraryResult {
  const info = hit.info;
  return {
    id: info.key,
    source: 'dblp',
    title: info.title || 'Untitled',
    authors: authorNames(info.authors),
    year: info.year ? Number(info.year) : undefined,
    subjects: info.venue ? [info.venue] : undefined,
    hasFullText: false,
    previewUrl: info.ee || info.url,
  };
}

export async function dblpSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<DblpSearchResponse>(
    `${SEARCH_URL}?q=${encodeURIComponent(query)}&format=json&h=${limit}`,
  );
  return (data.result?.hits?.hit ?? []).map(normalizeDblpHit);
}

// A dblp record key looks like "conf/geoindustry/YussifLUH25" or
// "journals/entropy/Edmonds25a" - each '/'-separated segment is percent
// encoded individually so an unusual key (rare, but dblp keys can contain
// non-ASCII author disambiguation suffixes) still round-trips.
function bibUrl(key: string): string {
  return `${REC_BASE}/${key.split('/').map(encodeURIComponent).join('/')}.bib`;
}

// Handles one level of brace nesting ("{Turing} machines"), which covers
// the field values dblp's own BibTeX export actually produces.
function extractBibField(bib: string, field: string): string | undefined {
  const match = bib.match(new RegExp(`${field}\\s*=\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`));
  return match?.[1]?.replace(/\s+/g, ' ').trim();
}

export function parseDblpBibtex(bib: string): { title: string; authors: string[]; year?: number } {
  const title = extractBibField(bib, 'title');
  const authorField = extractBibField(bib, 'author');
  const year = extractBibField(bib, 'year');
  return {
    title: title || '',
    authors: authorField ? authorField.split(' and ').map((a) => a.trim()) : [],
    year: year ? Number(year) : undefined,
  };
}

export async function dblpRead(key: string): Promise<ReadResult> {
  const bib = await fetchText(bibUrl(key));
  const parsed = parseDblpBibtex(bib);
  return {
    title: parsed.title || key,
    authors: parsed.authors,
    year: parsed.year,
    ...truncateText(bib.trim()),
  };
}

register('dblp', {
  description:
    "DBLP: venue-precise computer science bibliography search. No API key required. Keyless, paced at 1 request/second per dblp's own guidance.",
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://dblp.org',
  verifiedAt: '2026-09-03',
  pacing: { minIntervalMs: 1000 },
  search: dblpSearch,
  read: dblpRead,
});
