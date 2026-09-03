import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { stripHtml } from '../utils/text-clean.ts';
import { asArray, parseXml, textOf } from '../utils/xml.ts';
import { register, truncateText } from './registry.ts';

const API = 'https://export.arxiv.org/api/query';
const HTML = 'https://arxiv.org/html';

interface ArxivAuthor {
  name?: string;
}

interface ArxivEntry {
  // Typed `unknown`, not `string`: a plain <title>text</title> parses to a
  // string, but an attributed leaf like <title type="html">text</title>
  // parses to { '@_type': 'html', '#text': 'text' } instead. cleanField()
  // (via the shared textOf()) handles either shape.
  id?: unknown;
  title?: unknown;
  summary?: unknown;
  published?: unknown;
  author?: ArxivAuthor | ArxivAuthor[];
  'arxiv:primary_category'?: { '@_term'?: string };
}

interface ArxivFeed {
  feed?: { entry?: ArxivEntry | ArxivEntry[] };
}

// arxiv's Atom text fields are line-wrapped at source (titles and
// abstracts routinely carry embedded newlines); collapse to single spaces
// the way the pre-migration node-html-parser-based extraction did. Routed
// through the shared textOf() first, since an attributed leaf (e.g.
// <title type="html">...</title>) parses to an object, not a bare string.
function cleanField(s: unknown): string {
  return textOf(s).replace(/\s+/g, ' ').trim();
}

function parseId(raw: string): string {
  return raw.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
}

// A self-closing `<name/>` (no attributes, no text) parses to '', so
// cleanField(a.name) yields '' rather than undefined - unfiltered, that
// added a spurious empty-string author the pre-migration node-html-parser
// extraction never produced (final wave, B7).
function authorsOf(entry: Pick<ArxivEntry, 'author'> | undefined): string[] {
  return asArray(entry?.author)
    .map((a) => cleanField(a.name))
    .filter(Boolean);
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
    const authors = authorsOf(entry);
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
        authors: authorsOf(entry),
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
    authors: authorsOf(entry),
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
