import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.core.ac.uk/v3';

function headers(): Record<string, string> {
  const key = process.env.CORE_API_KEY;
  if (!key)
    throw new Error(
      'CORE requires CORE_API_KEY. Register a free key at: https://core.ac.uk/services/api ' +
        'then set CORE_API_KEY in your environment.',
    );
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

export function normalizeCore(data: CoreSearchResponse): LibraryResult[] {
  return (data.results || []).map((w) => ({
    id: String(w.id),
    source: 'core' as const,
    title: w.title || 'Untitled',
    authors: (w.authors || []).map((a) => a.name),
    year: w.yearPublished,
    subjects: w.fieldOfStudy || [],
    language: w.language?.code,
    hasFullText: Boolean(w.fullText || w.downloadUrl || w.abstract),
    previewUrl: w.downloadUrl,
    description: w.abstract?.substring(0, 300),
  }));
}

export async function coreSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  // Trailing slash: a bare /search/works?... 301-redirects to /search/works/
  // (confirmed live) — request the final URL directly.
  const data = await fetchJSON<CoreSearchResponse>(
    `${BASE}/search/works/?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: headers() },
  );
  return normalizeCore(data);
}

export async function coreRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const w = await fetchJSON<CoreWork>(`${BASE}/works/${id}`, { headers: headers() });
  const text = w.fullText || w.abstract;
  if (!text) throw new Error(`CORE work ${id} has no retrievable text`);
  return {
    text,
    title: w.title || id,
    authors: (w.authors || []).map((a) => a.name),
    year: w.yearPublished,
    language: w.language?.code,
  };
}

register('core', {
  description:
    'CORE — 57M+ open access research papers with full text. Broadest OA academic aggregator across all disciplines. Requires free CORE_API_KEY.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://core.ac.uk',
  auth: { type: 'header', env: 'CORE_API_KEY', header: 'Authorization' },
  pacing: { minIntervalMs: 2100 },
  search: coreSearch,
  async read(id) {
    const raw = await coreRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
