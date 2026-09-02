import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.nb.no/catalog/v1';

interface NBItem {
  id?: string;
  metadata?: {
    title?: string;
    creators?: Array<{ name?: string }>;
    yearOfPublication?: string | number;
    description?: string;
    language?: string;
    subject?: string[];
  };
  _links?: {
    self?: { href: string };
  };
}

interface NBResponse {
  _embedded?: { items?: NBItem[] };
  page?: { totalElements?: number };
}

export async function nbnorwaySearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<NBResponse>(
    `${BASE}/items?q=${encodeURIComponent(query)}&size=${limit}&digital=true`,
  );

  return (data._embedded?.items || []).map((item) => {
    const m = item.metadata || {};
    const id = item.id || item._links?.self?.href?.split('/').pop() || '';
    return {
      id,
      source: 'nbnorway' as const,
      title: m.title || 'Untitled',
      authors: (m.creators || []).map((c) => c.name || '').filter(Boolean),
      year: m.yearOfPublication ? parseInt(String(m.yearOfPublication), 10) : undefined,
      subjects: m.subject || [],
      language: m.language,
      hasFullText: Boolean(m.description),
      previewUrl: item._links?.self?.href,
      description: m.description?.substring(0, 300),
    };
  });
}

export async function nbnorwayRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const item = await fetchJSON<NBItem>(`${BASE}/items/${id}`);
  const m = item.metadata || {};

  return {
    text: m.description || `No description available for NB Norway item ${id}`,
    title: m.title || id,
    authors: (m.creators || []).map((c) => c.name || '').filter(Boolean),
    year: m.yearOfPublication ? parseInt(String(m.yearOfPublication), 10) : undefined,
    language: m.language,
  };
}

register('nbnorway', {
  description:
    'National Library of Norway — digitized books, manuscripts, and newspapers with OCR text in JSON. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'culture',
  freshness: 'daily',
  homepage: 'https://www.nb.no',
  verifiedAt: '2026-09-01',
  search: nbnorwaySearch,
  async read(id) {
    const raw = await nbnorwayRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
