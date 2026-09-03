import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { asArray, findDeep, parseXml, textOf } from '../utils/xml.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://www.legislation.gov.uk';

interface AtomEntry {
  id?: string;
  title?: string;
  updated?: string;
  category?: unknown[];
}

interface AtomFeed {
  feed?: { entry?: AtomEntry | AtomEntry[] };
}

// self-closing `<category term="x"/>` parses to `{ '@_term': 'x' }` with no
// text at all; the shared textOf() covers that (attribute-only) case and
// the plain-string case alike, returning '' when there's no text content.
// findDeep/textOf are the shared xml.ts versions (this used to carry its
// own copy, same as legislationscot.ts and ndl.ts each did).
function cleanField(s: string | undefined): string {
  return (s ?? '').trim();
}

// legislation.gov.uk's full-text data.xml documents can run to hundreds of
// KB of nested Akoma-Ntoso-style markup; the caller only wants the readable
// text, not a structured tree, so this stays a flat regex strip rather than
// a parseXml() walk of the whole document.
function stripXml(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIdFromUri(uri: string): string {
  // https://www.legislation.gov.uk/ukpga/2023/1 -> ukpga/2023/1
  return uri.replace(/^https?:\/\/www\.legislation\.gov\.uk\//, '').replace(/\/$/, '');
}

// Title from a data.xml document's own metadata: dc:title (usually two, an
// English one first and a Welsh one under xml:lang="cy") wins over the
// plain Title element used by older schema versions.
export function extractTitle(xml: string): string {
  const doc = parseXml<Record<string, unknown>>(xml);
  const dcTitle = textOf(asArray(findDeep(doc, 'dc:title'))[0]);
  const plainTitle = textOf(asArray(findDeep(doc, 'Title'))[0]);
  return dcTitle || plainTitle;
}

export function normalizeLegislation(atom: string): LibraryResult[] {
  const doc = parseXml<AtomFeed>(atom, { isArray: ['entry', 'category'] });
  const entries = asArray(doc.feed?.entry);

  return entries
    .map((entry) => {
      const rawId = cleanField(entry.id);
      const id = parseIdFromUri(rawId);
      const title = cleanField(entry.title);
      const updated = cleanField(entry.updated);
      const categories = asArray(entry.category).map(textOf).filter(Boolean);
      const year = updated ? parseInt(updated.substring(0, 4), 10) : undefined;

      return {
        id,
        source: 'legislation' as const,
        title,
        authors: [],
        year,
        subjects: categories,
        hasFullText: Boolean(id),
        previewUrl: rawId || `${BASE}/${id}`,
      };
    })
    .filter((r) => r.id);
}

export async function legislationSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const atom = await fetchText(
    `${BASE}/search?q=${encodeURIComponent(query)}&results-count=${limit}`,
  );
  return normalizeLegislation(atom);
}

export async function legislationRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  // Fetch XML version — content negotiation via /data.xml
  const xml = await fetchText(`${BASE}/${id}/data.xml`);
  const text = stripXml(xml);

  if (text.length < 100) {
    throw new Error(
      `legislation.gov.uk returned no text for ${id}. The item may not have a current XML version.`,
    );
  }

  const title = extractTitle(xml) || id;
  const yearMatch = id.match(/(\d{4})/);

  return {
    text,
    title,
    authors: [],
    year: yearMatch ? parseInt(yearMatch[1], 10) : undefined,
    language: 'en',
  };
}

register('legislation', {
  description:
    'legislation.gov.uk — UK Acts of Parliament, Statutory Instruments, and devolved legislation with time-aware full text. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'law',
  freshness: 'daily',
  homepage: 'https://www.legislation.gov.uk',
  verifiedAt: '2026-09-01',
  search: legislationSearch,
  async read(id) {
    const raw = await legislationRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
