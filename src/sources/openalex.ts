import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://api.openalex.org';
const MAILTO = process.env.CONTACT_EMAIL || '';
if (!MAILTO) console.warn('CONTACT_EMAIL environment variable is not set');

interface OAWork {
  id: string;
  title?: string;
  authorships?: Array<{ author: { display_name: string } }>;
  publication_year?: number;
  language?: string;
  concepts?: Array<{ display_name: string; level: number }>;
  open_access?: { is_oa?: boolean; oa_url?: string };
  doi?: string;
  abstract_inverted_index?: Record<string, number[]>;
  cited_by_count?: number;
}

interface OAResponse {
  results: OAWork[];
  meta?: { count: number };
}

// OpenAlex stores abstracts as inverted index — reconstruct
function invertedToAbstract(inv?: Record<string, number[]>): string {
  if (!inv) return '';
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map(w => w[0]).join(' ');
}

export async function openalexSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<OAResponse>(
    `${BASE}/works?search=${encodeURIComponent(query)}&per_page=${limit}&mailto=${MAILTO}`
  );
  return (data.results || []).map(w => ({
    id: w.id.replace('https://openalex.org/', ''),
    source: 'openalex' as const,
    title: w.title || 'Untitled',
    authors: (w.authorships || []).map(a => a.author.display_name),
    year: w.publication_year,
    language: w.language,
    subjects: (w.concepts || []).filter(c => c.level <= 1).map(c => c.display_name),
    hasFullText: Boolean(w.open_access?.oa_url),
    previewUrl: w.open_access?.oa_url || (w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : undefined),
    description: invertedToAbstract(w.abstract_inverted_index).substring(0, 300) || undefined,
  }));
}

export async function openalexRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const w = await fetchJSON<OAWork>(`${BASE}/works/${id}?mailto=${MAILTO}`);
  const abstract = invertedToAbstract(w.abstract_inverted_index);
  return {
    text: abstract || `No abstract available for OpenAlex work ${id}`,
    title: w.title || id,
    authors: (w.authorships || []).map(a => a.author.display_name),
    year: w.publication_year,
    language: w.language,
  };
}

register('openalex', {
  description: 'OpenAlex — 200M+ scholarly works. Free replacement for Scopus/Web of Science. Covers all disciplines. No API key required.',
  supportsIngest: true,
  search: openalexSearch,
  async read(id) {
    const raw = await openalexRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
