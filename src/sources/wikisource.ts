import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { normaliseWhitespace } from '../utils/text-clean.ts';
import { register, truncateText } from './registry.ts';

const API = 'https://en.wikisource.org/w/api.php';

interface MWSearchResult {
  query: { search: Array<{ title: string; snippet: string; pageid: number }> };
}

interface MWPage {
  query: {
    pages: Record<
      string,
      {
        title: string;
        revisions?: Array<{ '*': string }>;
        categories?: Array<{ title: string }>;
      }
    >;
  };
}

export async function wikisourceSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    format: 'json',
    origin: '*',
  });
  const data = await fetchJSON<MWSearchResult>(`${API}?${params}`);

  return data.query.search.map((r) => ({
    id: r.title,
    source: 'wikisource' as const,
    title: r.title,
    authors: [],
    hasFullText: true,
    previewUrl: `https://en.wikisource.org/wiki/${encodeURIComponent(r.title)}`,
  }));
}

export async function wikisourceRead(
  title: string,
): Promise<{ text: string; title: string; authors: string[] }> {
  const params = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    format: 'json',
    origin: '*',
  });
  const data = await fetchJSON<MWPage>(`${API}?${params}`);
  const page = Object.values(data.query.pages)[0];
  if (!page) throw new Error(`Wikisource page not found: "${title}"`);

  const wikitext = page.revisions?.[0]?.['*'] ?? '';

  // Convert wikitext to plain text: strip templates, markup, links
  const plain = wikitext
    .replace(/\{\{[^}]*\}\}/g, '') // templates
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1') // [[link|text]] → text
    .replace(/'{2,3}/g, '') // bold/italic
    .replace(/==+([^=]+)==+/g, '\n\n$1\n\n') // headings
    .replace(/<[^>]+>/g, ' ') // HTML tags
    .replace(/\[\s*https?:\/\/[^\s\]]+[^\]]*\]/g, '') // external links
    .trim();

  return { text: normaliseWhitespace(plain), title: page.title, authors: [] };
}

register('wikisource', {
  description: 'Wikisource — multilingual library of free-content source texts in 70+ languages.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'daily',
  homepage: 'https://wikisource.org',
  verifiedAt: '2026-09-01',
  search: wikisourceSearch,
  async read(id) {
    const raw = await wikisourceRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
