// Hacker News, via the Algolia HN Search API. No API key required.
import type { LibraryResult } from '../types.ts';
import { stripHtml } from '../utils/text-clean.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://hn.algolia.com/api/v1';

interface HnHit {
  objectID: string;
  title?: string | null;
  author?: string;
  created_at: string;
  url?: string | null;
  story_text?: string | null;
}

interface HnSearchResponse {
  hits: HnHit[];
}

interface HnComment {
  author?: string;
  text?: string;
  children?: HnComment[];
}

interface HnItem {
  id: number;
  title?: string;
  text?: string;
  children?: HnComment[];
}

function itemUrl(id: string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function normalizeHn(hit: HnHit): LibraryResult {
  const year = new Date(hit.created_at).getFullYear();
  return {
    id: hit.objectID,
    source: 'hn',
    title: hit.title || `HN item ${hit.objectID}`,
    authors: hit.author ? [hit.author] : [],
    year: Number.isFinite(year) ? year : undefined,
    hasFullText: Boolean(hit.story_text),
    description: hit.story_text ? stripHtml(hit.story_text) : undefined,
    published: hit.created_at,
    url: hit.url || itemUrl(hit.objectID),
  };
}

function flattenComments(comments: HnComment[] | undefined, depth = 0): string[] {
  if (!comments) return [];
  const lines: string[] = [];
  for (const c of comments) {
    if (c.text) lines.push(`${'  '.repeat(depth)}${c.author ?? 'anonymous'}: ${stripHtml(c.text)}`);
    lines.push(...flattenComments(c.children, depth + 1));
  }
  return lines;
}

defineRest<HnSearchResponse>({
  name: 'hn',
  description:
    'Hacker News, via the Algolia HN Search API: stories and comments. No API key required.',
  cluster: 'developer',
  freshness: 'realtime',
  homepage: 'https://news.ycombinator.com',
  supportsIngest: true,
  verifiedAt: '2026-09-01',
  search: {
    url: (q, limit) => `${BASE}/search?query=${encodeURIComponent(q)}&hitsPerPage=${limit}`,
    pick: (raw) => raw.hits ?? [],
    normalize: normalizeHn,
  },
  read: {
    url: (id) => `${BASE}/items/${encodeURIComponent(id)}`,
    normalize: (raw: HnItem, id: string) => {
      const commentLines = flattenComments(raw.children);
      const text = [raw.text ? stripHtml(raw.text) : undefined, commentLines.join('\n')]
        .filter(Boolean)
        .join('\n\n');
      return {
        title: raw.title || `HN item ${id}`,
        authors: [],
        ...truncateText(text || `No text or comments found for HN item ${id}.`),
      };
    },
  },
});
