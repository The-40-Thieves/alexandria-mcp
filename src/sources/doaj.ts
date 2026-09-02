import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://doaj.org/api';

interface DOAJBib {
  title?: string;
  author?: Array<{ name: string }>;
  year?: string;
  abstract?: string;
  link?: Array<{ url: string; type: string }>;
  subject?: Array<{ term: string }>;
  journal?: { title?: string; language?: string[] };
}

interface DOAJResult {
  id: string;
  bibjson?: DOAJBib;
}

interface DOAJResponse {
  results?: DOAJResult[];
  total?: number;
}

export async function doajSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<DOAJResponse>(
    `${BASE}/search/articles/${encodeURIComponent(query)}?pageSize=${limit}`,
  );
  return (data.results || []).map((r) => {
    const b = r.bibjson || {};
    const link = b.link?.find((l) => l.type === 'fulltext');
    return {
      id: r.id,
      source: 'doaj' as const,
      title: b.title || 'Untitled',
      authors: (b.author || []).map((a) => a.name),
      year: b.year ? parseInt(b.year, 10) : undefined,
      language: b.journal?.language?.[0],
      subjects: (b.subject || []).map((s) => s.term),
      hasFullText: Boolean(b.abstract || link),
      previewUrl: link?.url,
      description: b.abstract?.substring(0, 300),
    };
  });
}

export async function doajRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<DOAJResult>(`${BASE}/articles/${id}`);
  const b = data.bibjson || {};
  return {
    text: b.abstract || `No abstract available for DOAJ article ${id}`,
    title: b.title || id,
    authors: (b.author || []).map((a) => a.name),
    year: b.year ? parseInt(b.year, 10) : undefined,
    language: b.journal?.language?.[0],
  };
}

register('doaj', {
  description:
    'DOAJ — Directory of Open Access Journals. 12M+ peer-reviewed OA articles from 20,000+ journals. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://doaj.org',
  verifiedAt: '2026-09-01',
  search: doajSearch,
  async read(id) {
    const raw = await doajRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
