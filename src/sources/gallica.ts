import { XMLParser } from 'fast-xml-parser';
import type { LibraryResult } from '../types.js';
import { fetchText } from '../utils/http.js';
import { normaliseWhitespace, stripHtml } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const SRU = 'https://gallica.bnf.fr/services/engine/search/sru';
const FULLTEXT = 'https://gallica.bnf.fr/services/engine/fulltext';

// removeNSPrefix strips namespace prefixes uniformly, so "srw:record"
// parses as "record" and "dc:title" (inside the oai_dc:dc wrapper) parses
// as "title": both prefixes collapse to the same unprefixed keys below.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
});

interface GallicaDc {
  title?: string | string[];
  creator?: string | string[];
  date?: string | string[];
  language?: string | string[];
  subject?: string | string[];
  identifier?: string | string[];
}

function toArray(val: unknown): unknown[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractYear(dateStr: string): number | undefined {
  const m = dateStr.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

export function normalizeGallica(xml: string, limit: number): LibraryResult[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = (doc.searchRetrieveResponse ?? doc) as Record<string, unknown>;
  const records = toArray((root.records as Record<string, unknown> | undefined)?.record);

  return records.slice(0, limit).flatMap((r) => {
    const rec = r as Record<string, unknown>;
    const dc = (rec.recordData as Record<string, unknown> | undefined)?.dc as GallicaDc | undefined;
    if (!dc) return [];

    const identifiers = toArray(dc.identifier).map(String);
    const ark = identifiers.find((i) => i.includes('ark:')) ?? identifiers[0] ?? '';

    return [
      {
        id: ark,
        source: 'gallica' as const,
        title: String(toArray(dc.title)[0] ?? ''),
        authors: toArray(dc.creator).map(String),
        year: extractYear(String(toArray(dc.date)[0] ?? '')),
        language: String(toArray(dc.language)[0] ?? ''),
        subjects: toArray(dc.subject).map(String).slice(0, 5),
        hasFullText: true,
        previewUrl: ark || undefined,
      },
    ];
  });
}

export async function gallicaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  // The previous code built `query` with a template literal and then let
  // URLSearchParams encode it, but the SRU service also needs the inner
  // quotes/parens literally, so passing the same string through
  // encodeURIComponent (as URLSearchParams does) a second time via a
  // pre-encoded template double-encoded it. Let URLSearchParams encode the
  // raw query exactly once.
  const params = new URLSearchParams({
    operation: 'searchRetrieve',
    version: '1.2',
    query: `(gallica all "${query}")`,
    maximumRecords: String(limit),
    recordSchema: 'dc',
  });
  const xml = await fetchText(`${SRU}?${params}`);
  return normalizeGallica(xml, limit);
}

export async function gallicaRead(ark: string): Promise<{
  text: string;
  title: string;
  authors: string[];
}> {
  const cleanArk = ark.replace(/^.*ark:\//, 'ark:/').replace(/^btv/, 'ark:/12148/btv');

  const html = await fetchText(`${FULLTEXT}/${encodeURIComponent(cleanArk)}/f1.highres`).catch(
    () => '',
  );

  if (html && html.length > 500) {
    return {
      text: normaliseWhitespace(stripHtml(html)),
      title: ark,
      authors: [],
    };
  }

  throw new Error(
    `Full text not available for Gallica item "${ark}". ` +
      `Not all Gallica items have OCR text — check https://gallica.bnf.fr/${ark} for available formats.`,
  );
}

register('gallica', {
  description:
    "Gallica/BnF — 5M+ digitized documents from the French national library. Full text available for OCR'd items.",
  supportsIngest: true,
  kind: 'rest',
  cluster: 'culture',
  freshness: 'daily',
  homepage: 'https://gallica.bnf.fr',
  verifiedAt: '2026-09-01',
  search: gallicaSearch,
  async read(id) {
    const raw = await gallicaRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
