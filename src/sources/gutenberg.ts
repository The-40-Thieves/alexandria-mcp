import type { LibraryResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { cleanGutenbergText } from '../utils/text-clean.ts';
import { register, truncateText } from './registry.ts';

const GUTENDEX_BASE = 'https://gutendex.com';

interface GutendexBook {
  id: number;
  title: string;
  authors: Array<{ name: string; birth_year?: number; death_year?: number }>;
  languages: string[];
  subjects: string[];
  formats: Record<string, string>;
  download_count: number;
}

interface GutendexResponse {
  count: number;
  results: GutendexBook[];
}

function pickTextUrl(formats: Record<string, string>): string | undefined {
  // Prefer plain text UTF-8, then plain text, then HTML
  return (
    formats['text/plain; charset=utf-8'] ||
    formats['text/plain'] ||
    formats['text/html; charset=utf-8'] ||
    formats['text/html']
  );
}

export function normalizeGutenberg(data: GutendexResponse): LibraryResult[] {
  return data.results.map((book) => ({
    id: String(book.id),
    source: 'gutenberg' as const,
    title: book.title,
    authors: book.authors.map((a) => a.name),
    language: book.languages[0],
    subjects: book.subjects.slice(0, 5),
    hasFullText: Boolean(pickTextUrl(book.formats)),
    downloadUrl: pickTextUrl(book.formats),
  }));
}

export async function gutenbergSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const url = `${GUTENDEX_BASE}/books/?search=${encodeURIComponent(query)}&page_size=${limit}`;
  const data = await fetchJSON<GutendexResponse>(url);
  return normalizeGutenberg(data);
}

export async function gutenbergRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
  year?: number;
}> {
  // Fetch metadata first to get the download URL
  const url = `${GUTENDEX_BASE}/books/${id}/`;
  const book = await fetchJSON<GutendexBook>(url);

  const textUrl = pickTextUrl(book.formats);
  if (!textUrl) {
    throw new Error(
      `No plain-text version available for Gutenberg book ${id}. ` +
        `Available formats: ${Object.keys(book.formats).join(', ')}`,
    );
  }

  // Rate limiting: Gutenberg asks for reasonable request rates
  await new Promise((r) => setTimeout(r, 500));

  const raw = await fetchText(textUrl);
  const text = cleanGutenbergText(raw);

  if (text.length < 500) {
    throw new Error(`Gutenberg book ${id} returned unexpectedly short text (${text.length} chars)`);
  }

  return {
    text,
    title: book.title,
    authors: book.authors.map((a) => a.name),
    language: book.languages[0],
  };
}

register('gutenberg', {
  description: 'Project Gutenberg — 76k+ public domain books, best for pre-1928 literature.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://www.gutenberg.org',
  verifiedAt: '2026-09-01',
  search: gutenbergSearch,
  async read(id) {
    const raw = await gutenbergRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
