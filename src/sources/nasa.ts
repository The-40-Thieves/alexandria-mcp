import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://ntrs.nasa.gov/api';

interface NTRSAuthor {
  meta?: { author?: { name?: string } };
}

interface NTRSDoc {
  id: string | number;
  title: string;
  abstract?: string;
  publicationDate?: string;
  authorAffiliations?: NTRSAuthor[];
  keywords?: string[];
  stiType?: string;
}

interface NTRSResponse {
  results: NTRSDoc[];
  count?: number;
}

function parseAuthors(aff?: NTRSAuthor[]): string[] {
  if (!aff) return [];
  return aff
    .map(a => a.meta?.author?.name)
    .filter((n): n is string => Boolean(n));
}

function parseYear(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const m = dateStr.match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

export async function nasaSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<NTRSResponse>(
    `${BASE}/citations/search?keyword=${encodeURIComponent(query)}&rows=${limit}`
  );
  return (data.results || []).map(d => ({
    id: String(d.id),
    source: 'nasa' as const,
    title: d.title,
    authors: parseAuthors(d.authorAffiliations),
    year: parseYear(d.publicationDate),
    subjects: d.keywords || [],
    hasFullText: Boolean(d.abstract),
    previewUrl: `https://ntrs.nasa.gov/citations/${d.id}`,
    description: d.abstract?.substring(0, 300),
  }));
}

export async function nasaRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const d = await fetchJSON<NTRSDoc>(`${BASE}/citations/${id}`);
  return {
    text: d.abstract || `No abstract available for NASA NTRS:${id}`,
    title: d.title || id,
    authors: parseAuthors(d.authorAffiliations),
    year: parseYear(d.publicationDate),
    language: 'en',
  };
}

register('nasa', {
  description: 'NASA NTRS — space science, aeronautics, and engineering technical reports. No API key required.',
  supportsIngest: true,
  search: nasaSearch,
  async read(id) {
    const raw = await nasaRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
