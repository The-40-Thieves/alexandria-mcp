import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { normaliseWhitespace } from '../utils/text-clean.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://runeberg.org';

const CATALOG: Array<{
  id: string;
  title: string;
  authors: string[];
  year?: number;
  language: string;
  subjects: string[];
  tocUrl: string;
}> = [
  {
    id: 'selma-jerusalem',
    title: 'Jerusalem',
    authors: ['Selma Lagerlöf'],
    year: 1901,
    language: 'en',
    subjects: ['Swedish literature', 'Novel'],
    tocUrl: `${BASE}/jerusalem/`,
  },
  {
    id: 'selma-nils',
    title: 'The Wonderful Adventures of Nils',
    authors: ['Selma Lagerlöf'],
    year: 1906,
    language: 'en',
    subjects: ['Swedish literature', 'Children'],
    tocUrl: `${BASE}/nils/`,
  },
  {
    id: 'strindberg-miss-julie',
    title: 'Miss Julie',
    authors: ['August Strindberg'],
    year: 1888,
    language: 'en',
    subjects: ['Swedish drama', 'Naturalism'],
    tocUrl: `${BASE}/missjulie/`,
  },
  {
    id: 'ibsen-doll-house',
    title: "A Doll's House",
    authors: ['Henrik Ibsen'],
    year: 1879,
    language: 'en',
    subjects: ['Norwegian drama', 'Feminism'],
    tocUrl: `${BASE}/dollshs/`,
  },
  {
    id: 'ibsen-peer-gynt',
    title: 'Peer Gynt',
    authors: ['Henrik Ibsen'],
    year: 1867,
    language: 'en',
    subjects: ['Norwegian drama', 'Folklore'],
    tocUrl: `${BASE}/peergynt/`,
  },
  {
    id: 'andersen-fairy-tales',
    title: 'Fairy Tales',
    authors: ['Hans Christian Andersen'],
    year: 1835,
    language: 'en',
    subjects: ['Danish literature', 'Fairy tales'],
    tocUrl: `${BASE}/andersen/`,
  },
  {
    id: 'kierkegaard-fear',
    title: 'Fear and Trembling',
    authors: ['Søren Kierkegaard'],
    year: 1843,
    language: 'en',
    subjects: ['Philosophy', 'Existentialism', 'Danish literature'],
    tocUrl: `${BASE}/feartrb/`,
  },
];

export function runbergSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return CATALOG.filter((e) =>
    terms.every((t) => [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase().includes(t)),
  )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      source: 'projectruneberg' as const,
      title: e.title,
      authors: e.authors,
      year: e.year,
      language: e.language,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: e.tocUrl,
    }));
}

export async function runbergRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
}> {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry)
    throw new Error(
      `Unknown Project Runeberg ID: "${id}". Use library_search with source="projectruneberg".`,
    );

  // Fetch TOC, find chapter .txt links
  const tocHtml = await fetchText(entry.tocUrl);
  const root = parse(tocHtml);
  const links = root
    .querySelectorAll('a[href]')
    .map((a) => a.getAttribute('href') ?? '')
    .filter((h) => h.endsWith('.txt'))
    .map((h) => (h.startsWith('http') ? h : `${entry.tocUrl}${h}`))
    .slice(0, 100);

  if (links.length === 0) {
    // Try direct text download
    const direct = await fetchText(`${entry.tocUrl}plain.txt`).catch(() => '');
    if (direct.length > 200)
      return { text: normaliseWhitespace(direct), title: entry.title, authors: entry.authors };
    throw new Error(`Could not find text files for Project Runeberg entry "${id}".`);
  }

  const parts: string[] = [];
  for (const link of links) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const txt = await fetchText(link);
      if (txt.length > 50) parts.push(txt);
    } catch {
      /* skip */
    }
  }

  return {
    text: normaliseWhitespace(parts.join('\n\n')),
    title: entry.title,
    authors: entry.authors,
  };
}

register('projectruneberg', {
  description:
    'Project Runeberg — Scandinavian literature and cultural heritage. Ibsen, Strindberg, Lagerlöf, Andersen, Kierkegaard.',
  supportsIngest: true,
  kind: 'scrape',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://runeberg.org',
  verifiedAt: '2026-09-01',
  search: (q, l) => Promise.resolve(runbergSearch(q, l)),
  async read(id) {
    const raw = await runbergRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
