import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.plos.org/search';
const FIELDS = 'id,title,author,publication_date,abstract,article_type,subject,journal';

interface PLOSDoc {
  id: string;
  title?: string;
  author?: string[];
  publication_date?: string;
  abstract?: string[];
  article_type?: string;
  subject?: string[];
  journal?: string;
}

interface PLOSResponse {
  response: { docs: PLOSDoc[]; numFound: number };
}

export async function plosSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<PLOSResponse>(
    `${BASE}?q=${encodeURIComponent(query)}&rows=${limit}&fl=${FIELDS}&wt=json`,
  );
  return (data.response?.docs || []).map((d) => ({
    id: d.id,
    source: 'plos' as const,
    title: d.title || 'Untitled',
    authors: d.author || [],
    year: d.publication_date ? parseInt(d.publication_date.substring(0, 4), 10) : undefined,
    subjects: d.subject || [],
    language: 'en',
    hasFullText: Boolean(d.abstract),
    previewUrl: `https://doi.org/${d.id}`,
    description: d.abstract?.[0]?.substring(0, 300),
  }));
}

export async function plosRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<PLOSResponse>(
    `${BASE}?q=id:"${encodeURIComponent(id)}"&fl=${FIELDS}&wt=json`,
  );
  const d = data.response?.docs?.[0];
  if (!d) throw new Error(`PLOS article not found: ${id}`);
  return {
    text: d.abstract?.[0] || `No abstract available for PLOS article ${id}`,
    title: d.title || id,
    authors: d.author || [],
    year: d.publication_date ? parseInt(d.publication_date.substring(0, 4), 10) : undefined,
    language: 'en',
  };
}

register('plos', {
  description:
    'PLOS — Public Library of Science journals. 100% open access. Biology, medicine, genetics, computational biology. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://www.plos.org',
  verifiedAt: '2026-09-01',
  search: plosSearch,
  async read(id) {
    const raw = await plosRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
