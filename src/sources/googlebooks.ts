import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
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

function getKey(): string {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key)
    throw new Error(
      'Google Books requires GOOGLE_BOOKS_API_KEY (the shared keyless quota is exhausted — ' +
        'confirmed live: every unauthenticated request returns 429 "Quota exceeded"). ' +
        'Create a free key at: https://console.cloud.google.com/apis/credentials then set GOOGLE_BOOKS_API_KEY.',
    );
  return key;
}

function buildUrl(q: string, maxResults: number): string {
  const params = new URLSearchParams({
    q,
    maxResults: String(maxResults),
    printType: 'books',
    filter: 'partial', // at minimum a preview
    projection: 'full',
    key: getKey(),
  });
  return `${API}?${params}`;
}

export function normalizeGoogleBooks(data: GBResponse, limit: number): LibraryResult[] {
  return (data.items ?? []).slice(0, limit).map((v) => {
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

export async function googleBooksSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<GBResponse>(buildUrl(query, Math.min(limit, 40)));
  return normalizeGoogleBooks(data, limit);
}

export async function googleBooksRead(id: string): Promise<{
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  text?: string;
  metadataOnly?: boolean;
  externalUrl?: string;
  note?: string;
}> {
  const data = await fetchJSON<GBVolume>(`${API}/${id}?key=${getKey()}`);
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
    } catch {
      /* fall through to preview */
    }
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
  description:
    'Google Books — 40M+ books. Full text for public domain titles; preview snippets for in-copyright works. Requires free GOOGLE_BOOKS_API_KEY (the shared keyless quota is exhausted).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'daily',
  homepage: 'https://books.google.com',
  auth: { type: 'query', env: 'GOOGLE_BOOKS_API_KEY', param: 'key' },
  search: googleBooksSearch,
  async read(id) {
    return googleBooksRead(id);
  },
});
