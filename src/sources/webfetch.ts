// webfetch: not a search engine, a direct door into the fetch tier.
// search() always returns [] (there's nothing to search); read() is what
// this source is for, letting library_read(source='webfetch', id=<url>)
// fetch and extract the text of any page the caller already has a URL for,
// e.g. a link surfaced by another source's search() or by the caller
// themselves. Always registered (no key, no env-gated URL to hide behind).
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

export async function webfetchSearch(): Promise<LibraryResult[]> {
  return [];
}

export async function webfetchRead(id: string): Promise<ReadResult> {
  const page = await fetchAsText(id);
  return { title: page.title, authors: [], externalUrl: id, ...truncateText(page.text) };
}

register('webfetch', {
  description:
    'Direct web fetch: search() always returns []; read(id=<url>) fetches and extracts the text of any http(s) page via the fetch tier (defuddle, then jina, then crawl4ai, whichever is configured). Use this to read a URL surfaced by another source, or any URL the caller already has.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'web',
  freshness: 'realtime',
  homepage: 'https://github.com/The-40-Thieves/alexandria-mcp',
  timeoutMs: 30000,
  search: webfetchSearch,
  read: webfetchRead,
});
