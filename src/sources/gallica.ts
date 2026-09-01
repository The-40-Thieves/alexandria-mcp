import { XMLParser } from 'fast-xml-parser';
import type { LibraryResult } from '../types.js';
import { fetchText } from '../utils/http.js';
import { normaliseWhitespace, stripHtml } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const SRU = 'https://gallica.bnf.fr/services/engine/search/sru';
const FULLTEXT = 'https://gallica.bnf.fr/services/engine/fulltext';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

export async function gallicaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    operation: 'searchRetrieve',
    version: '1.2',
    query: `gallica all "${query}" and dc.type all "text"`,
    maximumRecords: String(limit),
    recordSchema: 'dc',
  });

  const xml = await fetchText(`${SRU}?${params}`);
  const doc = parser.parse(xml);

  const records = toArray(doc?.['srw:searchRetrieveResponse']?.['srw:records']?.['srw:record']);

  return records.slice(0, limit).map((r: unknown) => {
    const rec = r as Record<string, unknown>;
    const dc =
      ((rec['srw:recordData'] as Record<string, unknown>)?.['oai_dc:dc'] as Record<
        string,
        unknown
      >) ?? {};
    const id = String(
      (dc['dc:identifier'] as string[] | string | undefined)?.[0] ?? dc['dc:identifier'] ?? '',
    );
    const ark = id.includes('ark:') ? id : '';

    return {
      id: ark || String(id),
      source: 'gallica' as const,
      title: String(toArray(dc['dc:title'])[0] ?? ''),
      authors: toArray(dc['dc:creator']).map(String),
      year: extractYear(String(toArray(dc['dc:date'])[0] ?? '')),
      language: String(toArray(dc['dc:language'])[0] ?? ''),
      subjects: toArray(dc['dc:subject']).map(String).slice(0, 5),
      hasFullText: true,
      previewUrl: ark ? `https://gallica.bnf.fr/${ark}` : undefined,
    };
  });
}

export async function gallicaRead(ark: string): Promise<{
  text: string;
  title: string;
  authors: string[];
}> {
  // ark format: ark:/12148/btv1b...  or just the btv1b... part
  const cleanArk = ark.replace(/^.*ark:\//, 'ark:/').replace(/^btv/, 'ark:/12148/btv');

  // Try full-text endpoint
  await new Promise((r) => setTimeout(r, 500));
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

function toArray(val: unknown): unknown[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractYear(dateStr: string): number | undefined {
  const m = dateStr.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

register('gallica', {
  description:
    "Gallica/BnF — 5M+ digitized documents from the French national library. Full text available for OCR'd items.",
  supportsIngest: true,
  search: gallicaSearch,
  async read(id) {
    const raw = await gallicaRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
