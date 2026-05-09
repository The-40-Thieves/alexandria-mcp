import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://api.adsabs.harvard.edu/v1';

function headers(): Record<string, string> {
  const key = process.env.NASA_ADS_API_KEY;
  if (!key) throw new Error('NASA_ADS_API_KEY is not set. Register free at https://ui.adsabs.harvard.edu/user/settings/token');
  return { Authorization: `Bearer ${key}` };
}

const FIELDS = 'bibcode,title,author,year,abstract,identifier,keyword,doctype';

interface ADSDoc {
  bibcode: string;
  title?: string[];
  author?: string[];
  year?: string;
  abstract?: string;
  identifier?: string[];
  keyword?: string[];
  doctype?: string;
}

interface ADSResponse {
  response: { docs: ADSDoc[]; numFound: number };
}

export async function nasaadsSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<ADSResponse>(
    `${BASE}/search/query?q=${encodeURIComponent(query)}&rows=${limit}&fl=${FIELDS}`,
    { headers: headers() }
  );
  return (data.response?.docs || []).map(d => {
    const arxivId = d.identifier?.find(i => i.startsWith('arXiv:'))?.replace('arXiv:', '');
    return {
      id: d.bibcode,
      source: 'nasaads' as const,
      title: d.title?.[0] || 'Untitled',
      authors: d.author || [],
      year: d.year ? parseInt(d.year, 10) : undefined,
      subjects: d.keyword || [],
      hasFullText: Boolean(d.abstract),
      previewUrl: arxivId
        ? `https://arxiv.org/abs/${arxivId}`
        : `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(d.bibcode)}`,
      description: d.abstract?.substring(0, 300),
    };
  });
}

export async function nasaadsRead(bibcode: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const data = await fetchJSON<ADSResponse>(
    `${BASE}/search/query?q=bibcode:${encodeURIComponent(`"${bibcode}"`)}&fl=${FIELDS}`,
    { headers: headers() }
  );
  const d = data.response?.docs?.[0];
  if (!d) throw new Error(`NASA ADS paper not found: ${bibcode}`);
  return {
    text: d.abstract || `No abstract available for NASA ADS ${bibcode}`,
    title: d.title?.[0] || bibcode,
    authors: d.author || [],
    year: d.year ? parseInt(d.year, 10) : undefined,
    language: 'en',
  };
}

register('nasaads', {
  description: 'NASA ADS — Astrophysics Data System. Premier portal for astronomy, astrophysics, and physics research. Requires NASA_ADS_API_KEY (free at ui.adsabs.harvard.edu).',
  supportsIngest: true,
  search: nasaadsSearch,
  async read(id) {
    const raw = await nasaadsRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
