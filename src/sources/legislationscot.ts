import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { asArray, findDeep, parseXml, textOf } from '../utils/xml.ts';
import { register, truncateText } from './registry.ts';

// Scottish Parliament legislation: Acts of the Scottish Parliament (asp)
// and Scottish Statutory Instruments (ssi) from legislation.gov.uk
const BASE = 'https://www.legislation.gov.uk';
const TYPES = 'asp+ssi'; // ASP = Acts of Scottish Parliament, SSI = Scottish Statutory Instruments

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
function cleanField(s: unknown): string {
  return textOf(s).trim();
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

function parseId(uri: string): string {
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

export function normalizeLegislationScot(atom: string): LibraryResult[] {
  const doc = parseXml<AtomFeed>(atom, { isArray: ['entry', 'category'] });
  const entries = asArray(doc.feed?.entry);

  return entries
    .map((entry) => {
      const rawId = cleanField(entry.id);
      const id = parseId(rawId);
      const title = cleanField(entry.title);
      const updated = cleanField(entry.updated);
      const categories = asArray(entry.category).map(textOf).filter(Boolean);
      const year = updated ? parseInt(updated.substring(0, 4), 10) : undefined;
      const isASP = id.startsWith('asp');
      return {
        id,
        source: 'legislationscot' as const,
        title,
        authors: [],
        year,
        subjects: [
          ...categories,
          isASP ? 'Acts of Scottish Parliament' : 'Scottish Statutory Instruments',
        ],
        hasFullText: Boolean(id),
        previewUrl: rawId || `${BASE}/${id}`,
      };
    })
    .filter((r) => r.id);
}

export async function legislationscotSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const atom = await fetchText(
    `${BASE}/${TYPES}/data.feed?text=${encodeURIComponent(query)}&results-count=${limit}`,
  );
  return normalizeLegislationScot(atom);
}

export async function legislationscotRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const xml = await fetchText(`${BASE}/${id}/data.xml`);
  const text = stripXml(xml);

  if (text.length < 100) {
    throw new Error(`legislation.gov.uk returned no text for ${id}.`);
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

register('legislationscot', {
  description:
    'Scottish Parliament legislation — Acts of the Scottish Parliament (ASP) and Scottish Statutory Instruments (SSI). No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'law',
  freshness: 'daily',
  homepage: 'https://www.legislation.gov.uk',
  verifiedAt: '2026-09-01',
  search: legislationscotSearch,
  async read(id) {
    const raw = await legislationscotRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
