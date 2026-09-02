import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.js';
import { fetchText } from '../utils/http.js';
import { normaliseWhitespace, stripHtml } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

// Standard Ebooks' OPDS catalog feed used by the old adapter is no longer a
// practical way to search (it lists the whole catalog with no query
// support). The website's own /ebooks?query= search page is now the
// search surface; scrape its result <li> entries directly.
const BASE = 'https://standardebooks.org';

export function normalizeStandardEbooksSearch(html: string, limit: number): LibraryResult[] {
  const root = parse(html);
  // The page has other <li>s outside the results list (nav menus etc.), so
  // filter to entries that actually look like a book (typeof="schema:Book")
  // before slicing to `limit` — slicing first can leave a well-populated
  // results list under-represented if unrelated <li>s sort earlier in the DOM.
  const items = root
    .querySelectorAll('li')
    .filter((li) => li.getAttribute('typeof') === 'schema:Book');

  return items
    .flatMap((li) => {
      const titleLink = li.querySelector('p a');
      const href = titleLink?.getAttribute('href') ?? '';
      const title = titleLink?.text?.trim() ?? '';
      if (!href || !title) return [];

      const bookId = href.replace(/^\/?ebooks\//, '').replace(/\/$/, '');
      const authorLink = li.querySelector('p.author a');
      const author = authorLink?.text?.trim();

      return [
        {
          id: bookId,
          source: 'standardebooks' as const,
          title,
          authors: author ? [author] : [],
          hasFullText: true,
          previewUrl: `${BASE}/ebooks/${bookId}`,
        },
      ];
    })
    .slice(0, limit);
}

export async function standardEbooksSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ query });
  const html = await fetchText(`${BASE}/ebooks?${params}`);
  return normalizeStandardEbooksSearch(html, limit);
}

export function extractStandardEbooksText(
  html: string,
  bookId: string,
): { text: string; title: string } {
  const root = parse(html);
  const title = root.querySelector('title')?.text?.trim() ?? bookId;

  // The single-page view puts all compiled CSS in one <style><![CDATA[...]]>
  // block in <head>; node-html-parser's element-removal doesn't reliably
  // drop CDATA-wrapped content in this XHTML doc, so strip <script>/<style>
  // by regex on the raw markup before extracting body text.
  const withoutStyleScript = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(withoutStyleScript);
  const text = normaliseWhitespace(stripHtml(bodyMatch?.[1] ?? withoutStyleScript));
  return { text, title };
}

export async function standardEbooksRead(bookId: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
}> {
  const html = await fetchText(`${BASE}/ebooks/${bookId}/text/single-page`);
  const { text, title } = extractStandardEbooksText(html, bookId);

  if (text.length < 500) {
    throw new Error(
      `Standard Ebooks "${bookId}" returned unexpectedly short text (${text.length} chars). ` +
        `Check https://standardebooks.org/ebooks/${bookId} for the correct ID.`,
    );
  }

  return { text, title, authors: [], language: 'en' };
}

register('standardebooks', {
  description: 'Standard Ebooks — carefully typeset and proofread public domain ebooks.',
  supportsIngest: true,
  kind: 'scrape',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://standardebooks.org',
  verifiedAt: '2026-09-01',
  search: standardEbooksSearch,
  async read(id) {
    const raw = await standardEbooksRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
