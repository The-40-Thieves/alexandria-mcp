// MDN Web Docs search. No API key required. A custom register() rather
// than defineRest(): read() is metadata only until the fetchTier web-fetch
// tier lands in Stage 6 (the same TODO convention used by nhk.ts and
// kinds/rss.ts), since MDN articles are HTML pages, not a JSON API, and
// defineRest()'s read() always expects a JSON response.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { fetchAsText } from '../web/fetchTier.js';
import { register, truncateText } from './registry.js';

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

// Retrieves and extracts the article body at the doc URL via the fetch tier
// (defuddle, then jina, then crawl4ai, whichever is configured). The id is
// arbitrary third-party web content that fetchAsText can fail on for all
// sorts of reasons (paywall, robots block, the whole chain unconfigured)
// that aren't a bug in this source, so a failure falls back to
// metadata-only with the error in `note`, the same convention as
// kinds/rss.ts.
export async function mdnRead(id: string): Promise<ReadResult> {
  const url = `${ORIGIN}${id}`;
  try {
    const page = await fetchAsText(url);
    return { title: page.title || id, authors: [], externalUrl: url, ...truncateText(page.text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: url,
      note: `Full-text fetch failed; showing metadata only: ${message}`,
    };
  }
}

register('mdn', {
  description: 'MDN Web Docs search: web platform reference and guides. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://developer.mozilla.org',
  // Superseded for routing by the mdnmcp source, which talks to the
  // upstream MCP server directly. Hidden rather than removed: it stays
  // registered and callable by name, and mdnmcp falls back to it.
  hidden: true,
  verifiedAt: '2026-09-01',
  search: mdnSearch,
  read: mdnRead,
});
