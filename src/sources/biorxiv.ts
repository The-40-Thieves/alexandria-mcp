import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://api.biorxiv.org';

interface BiorxivPaper {
  doi: string;
  title: string;
  authors: string;
  date: string;
  category: string;
  abstract: string;
}

interface BiorxivResponse {
  messages?: Array<{ status: string; total?: number }>;
  collection: BiorxivPaper[];
}

export async function biorxivSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<BiorxivResponse>(
    `${BASE}/search/biorxiv/${encodeURIComponent(query)}/0/${limit}`
  );
  return (data.collection || []).map(p => ({
    id: p.doi,
    source: 'biorxiv' as const,
    title: p.title,
    authors: p.authors ? p.authors.split('; ') : [],
    year: p.date ? parseInt(p.date.substring(0, 4), 10) : undefined,
    subjects: p.category ? [p.category] : [],
    language: 'en',
    hasFullText: Boolean(p.abstract),
    previewUrl: `https://www.biorxiv.org/content/${p.doi}`,
    description: p.abstract?.substring(0, 300),
  }));
}

export async function biorxivRead(doi: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const data = await fetchJSON<BiorxivResponse>(
    `${BASE}/details/biorxiv/${encodeURIComponent(doi)}/na/json`
  );
  const p = data.collection?.[0];
  if (!p) throw new Error(`bioRxiv paper not found: ${doi}`);
  return {
    text: p.abstract || `No abstract available for ${doi}`,
    title: p.title,
    authors: p.authors ? p.authors.split('; ') : [],
    year: p.date ? parseInt(p.date.substring(0, 4), 10) : undefined,
    language: 'en',
  };
}

register('biorxiv', {
  description: 'bioRxiv — biological sciences preprints. No API key required.',
  supportsIngest: true,
  search: biorxivSearch,
  async read(id) {
    const raw = await biorxivRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
