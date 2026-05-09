import { XMLParser } from 'fast-xml-parser';
import { fetchText } from '../utils/http.js';
import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

const OPDS_SEARCH = 'https://www.feedbooks.com/books/search.opds';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

interface FeedEntry {
  id?: string;
  title?: string;
  author?: { name?: string } | Array<{ name?: string }>;
  category?: Array<{ '@_term'?: string }> | { '@_term'?: string };
  link?: Array<{ '@_href'?: string; '@_type'?: string; '@_rel'?: string }> | { '@_href'?: string; '@_type'?: string; '@_rel'?: string };
  updated?: string;
}

interface OPDSFeed {
  feed?: { entry?: FeedEntry | FeedEntry[] };
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

export async function feedbooksSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ q: query });
  const xml = await fetchText(`${OPDS_SEARCH}?${params}`);
  const feed = parser.parse(xml) as OPDSFeed;
  const entries = toArray(feed.feed?.entry).slice(0, limit);

  return entries.map(e => {
    const authors = toArray(e.author).map(a => a.name ?? '').filter(Boolean);
    const links = toArray(e.link);

    // Find the acquisition link (EPUB download)
    const epubLink = links.find(l =>
      l['@_type']?.includes('epub') && l['@_rel']?.includes('acquisition')
    );
    const previewLink = links.find(l => l['@_rel']?.includes('alternate'));
    const id = String(e.id ?? '').replace(/^.*\//, '');

    return {
      id,
      source: 'feedbooks' as const,
      title: String(e.title ?? ''),
      authors,
      subjects: toArray(e.category).map(c => c['@_term'] ?? '').filter(Boolean).slice(0, 5),
      hasFullText: Boolean(epubLink),
      previewUrl: previewLink?.['@_href'] ?? `https://www.feedbooks.com/book/${id}`,
      downloadUrl: epubLink?.['@_href'],
    };
  });
}

register('feedbooks', {
  description: 'Feedbooks — curated public domain ebooks (OPDS catalog). Mostly mirrors Project Gutenberg with improved formatting. Discovery and EPUB download links.',
  supportsIngest: false,
  search: feedbooksSearch,
  async read(id) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: `https://www.feedbooks.com/book/${id}`,
      note: 'Feedbooks provides EPUB downloads. For plain text ingestion, find the same title on source="gutenberg" or source="archive".',
    };
  },
});
