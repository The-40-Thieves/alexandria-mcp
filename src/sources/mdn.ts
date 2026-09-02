// MDN Web Docs search. No API key required. A custom register() rather
// than defineRest(): read() is metadata only until the fetchTier web-fetch
// tier lands in Stage 6 (the same TODO convention used by nhk.ts and
// kinds/rss.ts), since MDN articles are HTML pages, not a JSON API, and
// defineRest()'s read() always expects a JSON response.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://developer.mozilla.org/api/v1';
const ORIGIN = 'https://developer.mozilla.org';

interface MdnDocument {
  mdn_url: string;
  title: string;
  summary?: string;
}

interface MdnSearchResponse {
  documents?: MdnDocument[];
}

export function normalizeMdn(doc: MdnDocument): LibraryResult {
  return {
    id: doc.mdn_url,
    source: 'mdn',
    title: doc.title,
    authors: [],
    hasFullText: false,
    description: doc.summary,
    url: `${ORIGIN}${doc.mdn_url}`,
  };
}

export async function mdnSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<MdnSearchResponse>(
    `${BASE}/search?q=${encodeURIComponent(query)}&locale=en-US&size=${limit}`,
  );
  return (data.documents ?? []).map(normalizeMdn);
}

// TODO(stage-6): fetchTier
export async function mdnRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    externalUrl: `${ORIGIN}${id}`,
    note: 'Full-text fetch for MDN arrives in a later stage; this is metadata only.',
  };
}

register('mdn', {
  description: 'MDN Web Docs search: web platform reference and guides. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://developer.mozilla.org',
  verifiedAt: '2026-09-01',
  search: mdnSearch,
  read: mdnRead,
});
