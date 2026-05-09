import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://zenodo.org/api';

function headers(): Record<string, string> {
  const key = process.env.ZENODO_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

interface ZenodoRecord {
  id: number;
  doi?: string;
  metadata: {
    title: string;
    description?: string;
    creators?: Array<{ name: string }>;
    publication_date?: string;
    keywords?: string[];
    language?: string;
    resource_type?: { type: string };
  };
}

interface ZenodoSearchResponse {
  hits: { hits: ZenodoRecord[]; total: number };
}

function cleanHtml(s?: string): string {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function zenodoSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<ZenodoSearchResponse>(
    `${BASE}/records?q=${encodeURIComponent(query)}&size=${limit}&sort=bestmatch`,
    { headers: headers() }
  );
  return (data.hits?.hits || []).map(r => ({
    id: String(r.id),
    source: 'zenodo' as const,
    title: r.metadata.title,
    authors: (r.metadata.creators || []).map(c => c.name),
    year: r.metadata.publication_date ? parseInt(r.metadata.publication_date.substring(0, 4), 10) : undefined,
    subjects: r.metadata.keywords || [],
    language: r.metadata.language,
    hasFullText: Boolean(r.metadata.description),
    previewUrl: r.doi ? `https://doi.org/${r.doi}` : `https://zenodo.org/record/${r.id}`,
    description: cleanHtml(r.metadata.description).substring(0, 300),
  }));
}

export async function zenodoRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const r = await fetchJSON<ZenodoRecord>(
    `${BASE}/records/${id}`,
    { headers: headers() }
  );
  return {
    text: cleanHtml(r.metadata.description) || `No description available for Zenodo record ${id}`,
    title: r.metadata.title || id,
    authors: (r.metadata.creators || []).map(c => c.name),
    year: r.metadata.publication_date ? parseInt(r.metadata.publication_date.substring(0, 4), 10) : undefined,
    language: r.metadata.language,
  };
}

register('zenodo', {
  description: 'Zenodo — CERN open repository: papers, datasets, software. 2M+ records across all disciplines.',
  supportsIngest: true,
  search: zenodoSearch,
  async read(id) {
    const raw = await zenodoRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
