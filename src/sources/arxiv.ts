import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { stripHtml } from '../utils/text-clean.ts';
import { asArray, parseXml } from '../utils/xml.ts';
import { register, truncateText } from './registry.ts';

const API = 'https://export.arxiv.org/api/query';
const HTML = 'https://arxiv.org/html';

interface ArxivAuthor {
  name?: string;
}

interface ArxivEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: ArxivAuthor | ArxivAuthor[];
  'arxiv:primary_category'?: { '@_term'?: string };
}

interface ArxivFeed {
  feed?: { entry?: ArxivEntry | ArxivEntry[] };
}

// arxiv's Atom text fields are line-wrapped at source (titles and
// abstracts routinely carry embedded newlines); collapse to single spaces
// the way the pre-migration node-html-parser-based extraction did.
function cleanField(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function parseId(raw: string): string {
  return raw.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
}

function entriesOf(xml: string): ArxivEntry[] {
  const doc = parseXml<ArxivFeed>(xml, { isArray: ['entry', 'author'] });
  return asArray(doc.feed?.entry);
}

export function normalizeArxiv(xml: string): LibraryResult[] {
  return entriesOf(xml).map((entry) => {
    const id = parseId(cleanField(entry.id));
    const title = cleanField(entry.title);
    const summary = cleanField(entry.summary);
    const published = cleanField(entry.published);
    const authors = asArray(entry.author).map((a) => cleanField(a.name));
    const cat = entry['arxiv:primary_category']?.['@_term'];
    return {
      id,
      source: 'arxiv' as const,
      title,
      authors,
      year: published ? parseInt(published.substring(0, 4), 10) : undefined,
      subjects: cat ? [cat] : [],
      hasFullText: true,
      previewUrl: `https://arxiv.org/abs/${id}`,
      description: summary.substring(0, 300),
    };
  });
}

export async function arxivSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const xml = await fetchText(
    `${API}?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&sortBy=relevance`,
  );
  return normalizeArxiv(xml);
}

export async function arxivRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  // Try HTML version first (most papers 2018+)
  try {
    const html = await fetchText(`${HTML}/${id}`);
    const fullText = stripHtml(html);
    if (fullText.length > 500) {
      const meta = await fetchText(`${API}?id_list=${id}`);
      const entry = entriesOf(meta)[0];
      const published = cleanField(entry?.published);
      return {
        text: fullText,
        title: cleanField(entry?.title) || id,
        authors: asArray(entry?.author).map((a) => cleanField(a.name)),
        year: published ? parseInt(published.substring(0, 4), 10) : undefined,
        language: 'en',
      };
    }
  } catch {
    /* fall through */
  }

  // Fall back to abstract
  const xml = await fetchText(`${API}?id_list=${id}`);
  const entry = entriesOf(xml)[0];
  const published = cleanField(entry?.published);
  return {
    text: cleanField(entry?.summary) || `No text available for arxiv:${id}`,
    title: cleanField(entry?.title) || id,
    authors: asArray(entry?.author).map((a) => cleanField(a.name)),
    year: published ? parseInt(published.substring(0, 4), 10) : undefined,
    language: 'en',
  };
}

register('arxiv', {
  description:
    'arXiv — 2M+ open access preprints: physics, math, CS, biology, economics, statistics. Full HTML text for most papers (2018+).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://arxiv.org',
  verifiedAt: '2026-09-01',
  // arXiv's API terms of use ask for a single connection at a time with at
  // least a 3s gap between requests; the registry's rateLimited() wrapper
  // already serializes calls per source, so this interval both spaces
  // requests out and keeps them to one in flight.
  pacing: { minIntervalMs: 3100 },
  search: arxivSearch,
  async read(id) {
    const raw = await arxivRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
