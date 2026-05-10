import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://api.crossref.org/works';
const MAILTO = 'contact@the13thletter.co';

interface CRAuthor { given?: string; family?: string; name?: string; }
interface CRLink { URL: string; 'content-type': string; }
interface CRWork {
  DOI: string;
  title?: string[];
  author?: CRAuthor[];
  abstract?: string;
  published?: { 'date-parts': number[][] };
  link?: CRLink[];
  subject?: string[];
  type?: string;
  'is-referenced-by-count'?: number;
  language?: string;
}
interface CRResponse {
  message: { items?: CRWork[]; 'total-results'?: number } | CRWork;
}

function authorName(a: CRAuthor): string {
  return a.name || `${a.given || ''} ${a.family || ''}`.trim();
}

function oaPdfLink(links?: CRLink[]): string | undefined {
  if (!links) return undefined;
  return links.find(l => l['content-type'] === 'application/pdf')?.URL;
}

export async function crossrefSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<CRResponse>(
    `${BASE}?query=${encodeURIComponent(query)}&rows=${limit}&mailto=${MAILTO}`
  );
  const msg = data.message as { items: CRWork[] };
  return (msg.items || []).map(w => {
    const dateParts = w.published?.['date-parts']?.[0];
    return {
      id: w.DOI,
      source: 'crossref' as const,
      title: w.title?.[0] || 'Untitled',
      authors: (w.author || []).map(authorName),
      year: dateParts?.[0],
      language: w.language,
      subjects: w.subject || [],
      hasFullText: Boolean(oaPdfLink(w.link) || w.abstract),
      previewUrl: oaPdfLink(w.link) || `https://doi.org/${w.DOI}`,
      description: w.abstract?.replace(/<[^>]+>/g, ' ').substring(0, 300),
    };
  });
}

export async function crossrefRead(doi: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const data = await fetchJSON<CRResponse>(
    `${BASE}/${encodeURIComponent(doi)}?mailto=${MAILTO}`
  );
  const w = data.message as CRWork;
  const dateParts = w.published?.['date-parts']?.[0];
  return {
    text: w.abstract?.replace(/<[^>]+>/g, ' ').trim() || `No abstract available for DOI ${doi}`,
    title: w.title?.[0] || doi,
    authors: (w.author || []).map(authorName),
    year: dateParts?.[0],
    language: w.language,
  };
}

register('crossref', {
  description: 'Crossref — 130M+ scholarly works. DOI registry with metadata, abstracts, and PDF links. No API key required.',
  supportsIngest: true,
  search: crossrefSearch,
  async read(id) {
    const raw = await crossrefRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
