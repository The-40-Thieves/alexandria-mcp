import { XMLParser } from 'fast-xml-parser';
import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { normaliseWhitespace, stripHtml } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const OPDS = 'https://standardebooks.org/opds';
const GITHUB_API = 'https://api.github.com/repos/standardebooks';
const GITHUB_RAW = 'https://raw.githubusercontent.com/standardebooks';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

interface OPDSEntry {
  id: string;
  title: string;
  author?: { name: string } | Array<{ name: string }>;
  category?: Array<{ '@_term': string }> | { '@_term': string };
  link?: Array<{ '@_href': string; '@_type': string }> | { '@_href': string; '@_type': string };
}

interface OPDSFeed {
  feed?: { entry?: OPDSEntry[] };
}

export async function standardEbooksSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const xml = await fetchText(`${OPDS}/all`);
  const feed = parser.parse(xml) as OPDSFeed;
  const entries = feed.feed?.entry ?? [];
  const q = query.toLowerCase();

  const matched = entries
    .filter((e) => {
      const title = String(e.title ?? '').toLowerCase();
      const authors = Array.isArray(e.author)
        ? e.author
            .map((a) => a.name)
            .join(' ')
            .toLowerCase()
        : String((e.author as { name: string } | undefined)?.name ?? '').toLowerCase();
      return title.includes(q) || authors.includes(q);
    })
    .slice(0, limit);

  return matched.map((e) => {
    const bookId = String(e.id ?? '').replace('https://standardebooks.org/ebooks/', '');
    const authors = Array.isArray(e.author)
      ? e.author.map((a) => a.name)
      : e.author
        ? [e.author.name]
        : [];

    return {
      id: bookId,
      source: 'standardebooks' as const,
      title: String(e.title ?? ''),
      authors,
      hasFullText: true,
      previewUrl: `https://standardebooks.org/ebooks/${bookId}`,
    };
  });
}

// Standard Ebooks GitHub repos follow the pattern: {author}_{title}
// The OPDS id path encodes this: e.g. jane-austen/pride-and-prejudice
// → repo: standardebooks/jane-austen_pride-and-prejudice
function bookIdToRepo(bookId: string): string {
  // bookId looks like "jane-austen/pride-and-prejudice"
  const parts = bookId.split('/');
  return parts.join('_');
}

export async function standardEbooksRead(bookId: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
}> {
  const repo = bookIdToRepo(bookId);
  const branch = 'master';
  const textDir = `${GITHUB_RAW}/${repo}/${branch}/src/epub/text`;

  // Get list of files from GitHub API
  interface GHFile {
    name: string;
    download_url: string;
    type: string;
  }
  let files: GHFile[] = [];
  try {
    files = await fetchJSON<GHFile[]>(`${GITHUB_API}/${repo}/contents/src/epub/text`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch {
    throw new Error(
      `Could not find Standard Ebooks source for "${bookId}". ` +
        `Check https://standardebooks.org/ebooks/${bookId} for the correct ID.`,
    );
  }

  const contentFiles = files
    .filter((f) => f.type === 'file' && (f.name.endsWith('.xhtml') || f.name.endsWith('.html')))
    .filter(
      (f) =>
        !f.name.includes('titlepage') &&
        !f.name.includes('colophon') &&
        !f.name.includes('imprint'),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const parts: string[] = [];
  for (const file of contentFiles) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const html = await fetchText(`${textDir}/${file.name}`);
      const text = normaliseWhitespace(stripHtml(html));
      if (text.length > 100) parts.push(text);
    } catch {
      /* skip */
    }
  }

  if (parts.length === 0) throw new Error(`No text content found for Standard Ebooks "${bookId}".`);

  // Extract title/author from the bookId
  const segments = bookId.split('/');
  const title = segments.slice(1).join(' / ').replace(/-/g, ' ');
  const author = segments[0]?.replace(/-/g, ' ') ?? '';

  return {
    text: parts.join('\n\n---\n\n'),
    title,
    authors: author ? [author] : [],
    language: 'en',
  };
}

register('standardebooks', {
  description: 'Standard Ebooks — carefully typeset and proofread public domain ebooks.',
  supportsIngest: true,
  search: standardEbooksSearch,
  async read(id) {
    const raw = await standardEbooksRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
