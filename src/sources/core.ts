import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://api.core.ac.uk/v3';

function headers(): Record<string, string> {
  const key = process.env.CORE_API_KEY;
  if (!key) throw new Error('CORE_API_KEY is not set');
  return { Authorization: `Bearer ${key}` };
}

interface CoreWork {
  id: string;
  title?: string;
  authors?: Array<{ name: string }>;
  yearPublished?: number;
  abstract?: string;
  fullText?: string;
  downloadUrl?: string;
  fieldOfStudy?: string[];
  language?: { code: string };
}

interface CoreSearchResponse {
  results: CoreWork[];
  totalHits: number;
}

export async function coreSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<CoreSearchResponse>(
    `${BASE}/search/works?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: headers() }
  );
  return (data.results || []).map(w => ({
    id: String(w.id),
    source: 'core' as const,
    title: w.title || 'Untitled',
    authors: (w.authors || []).map(a => a.name),
    year: w.yearPublished,
    subjects: w.fieldOfStudy || [],
    language: w.language?.code,
    hasFullText: Boolean(w.fullText || w.downloadUrl || w.abstract),
    previewUrl: w.downloadUrl,
    description: w.abstract?.substring(0, 300),
  }));
}

export async function coreRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const w = await fetchJSON<CoreWork>(
    `${BASE}/works/${id}`,
    { headers: headers() }
  );
  const text = w.fullText || w.abstract;
  if (!text) throw new Error(`CORE work ${id} has no retrievable text`);
  return {
    text,
    title: w.title || id,
    authors: (w.authors || []).map(a => a.name),
    year: w.yearPublished,
    language: w.language?.code,
  };
}

register('core', {
  description: 'CORE — 57M+ open access research papers with full text. Broadest OA academic aggregator across all disciplines.',
  supportsIngest: true,
  search: coreSearch,
  async read(id) {
    const raw = await coreRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
