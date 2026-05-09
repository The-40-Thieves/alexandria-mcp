import { fetchJSON } from '../utils/http.js';
import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

const API = 'https://www.googleapis.com/books/v1/volumes';

interface GBVolume {
  id: string;
  volumeInfo: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    language?: string;
    categories?: string[];
    description?: string;
    previewLink?: string;
    accessInfo?: { viewability?: string; publicDomain?: boolean };
  };
  accessInfo?: { viewability?: string; publicDomain?: boolean };
}

interface GBResponse {
  totalItems: number;
  items?: GBVolume[];
}

function buildUrl(q: string, maxResults: number): string {
  const params = new URLSearchParams({
    q,
    maxResults: String(maxResults),
    printType: 'books',
    filter: 'partial', // at minimum a preview
    projection: 'full',
  });
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (key) params.set('key', key);
  return `${API}?${params}`;
}

export async function googleBooksSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<GBResponse>(buildUrl(query, Math.min(limit, 40)));

  return (data.items ?? []).slice(0, limit).map(v => {
    const info = v.volumeInfo;
    const access = v.accessInfo ?? info.accessInfo;
    const publicDomain = access?.publicDomain ?? false;
    return {
      id: v.id,
      source: 'googlebooks' as const,
      title: info.title ?? v.id,
      authors: info.authors ?? [],
      year: info.publishedDate ? parseInt(info.publishedDate, 10) : undefined,
      language: info.language,
      subjects: (info.categories ?? []).slice(0, 5),
      hasFullText: publicDomain || access?.viewability === 'ALL_PAGES',
      previewUrl: info.previewLink ?? `https://books.google.com/books?id=${v.id}`,
    };
  });
}

export async function googleBooksRead(id: string): Promise<{
  title: string; authors: string[]; year?: number; language?: string;
  text?: string; metadataOnly?: boolean; externalUrl?: string; note?: string;
}> {
  const data = await fetchJSON<GBVolume>(`${API}/${id}${process.env.GOOGLE_BOOKS_API_KEY ? `?key=${process.env.GOOGLE_BOOKS_API_KEY}` : ''}`);
  const info = data.volumeInfo;
  const access = data.accessInfo;
  const publicDomain = access?.publicDomain ?? false;

  if (publicDomain) {
    // Public domain books have a downloadable plain text via a different API
    // Direct text: https://books.google.com/books/download/{id}.txt?id={id}&output=txt
    try {
      const textUrl = `https://books.google.com/books/download/${id}.txt?id=${id}&output=txt`;
      const { fetchText } = await import('../utils/http.js');
      const text = await fetchText(textUrl);
      if (text && text.length > 500) {
        return {
          title: info.title ?? id,
          authors: info.authors ?? [],
          year: info.publishedDate ? parseInt(info.publishedDate, 10) : undefined,
          language: info.language,
          text: text.slice(0, 200_000),
          metadataOnly: false,
        };
      }
    } catch { /* fall through to preview */ }
  }

  // Non-public-domain or download failed — return description + metadata
  return {
    title: info.title ?? id,
    authors: info.authors ?? [],
    year: info.publishedDate ? parseInt(info.publishedDate, 10) : undefined,
    language: info.language,
    metadataOnly: true,
    externalUrl: info.previewLink ?? `https://books.google.com/books?id=${id}`,
    note: publicDomain
      ? 'Public domain book — text download failed. Preview available at externalUrl.'
      : 'Google Books provides previews only for non-public-domain works. Full text at externalUrl if available.',
  };
}

register('googlebooks', {
  description: 'Google Books — 40M+ books. Full text for public domain titles; preview snippets for in-copyright works. Set GOOGLE_BOOKS_API_KEY for higher rate limits.',
  supportsIngest: true,
  search: googleBooksSearch,
  async read(id) {
    return googleBooksRead(id);
  },
});
