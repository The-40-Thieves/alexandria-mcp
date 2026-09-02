import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.ies.ed.gov/eric';
const FIELDS = 'id,title,author,publicationdateyear,description,subject,languagecode,url';

interface ERICDoc {
  id: string;
  title: string;
  author?: string[];
  publicationdateyear?: number;
  description?: string;
  subject?: string[];
  languagecode?: string;
  url?: string;
}

interface ERICResponse {
  response: { docs: ERICDoc[]; numFound: number };
}

export async function ericSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<ERICResponse>(
    `${BASE}/?search=${encodeURIComponent(query)}&rows=${limit}&fields=${FIELDS}&format=json`,
  );
  return (data.response?.docs || []).map((d) => ({
    id: d.id,
    source: 'eric' as const,
    title: d.title,
    authors: d.author || [],
    year: d.publicationdateyear,
    subjects: d.subject || [],
    language: d.languagecode,
    hasFullText: Boolean(d.description),
    previewUrl: d.url || `https://eric.ed.gov/?id=${d.id}`,
    description: d.description?.substring(0, 300),
  }));
}

export async function ericRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<ERICResponse>(`${BASE}/?id=${id}&fields=${FIELDS}&format=json`);
  const d = data.response?.docs?.[0];
  if (!d) throw new Error(`ERIC record ${id} not found`);
  return {
    text: d.description || `No abstract available for ERIC:${id}`,
    title: d.title || id,
    authors: d.author || [],
    year: d.publicationdateyear,
    language: d.languagecode,
  };
}

register('eric', {
  description:
    'ERIC — 2M+ education research documents from the US Dept of Education. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://eric.ed.gov',
  verifiedAt: '2026-09-01',
  search: ericSearch,
  async read(id) {
    const raw = await ericRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
