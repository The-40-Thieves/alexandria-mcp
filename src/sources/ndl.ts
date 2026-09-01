import { XMLParser } from 'fast-xml-parser';
import type { LibraryResult } from '../types.js';
import { fetchText } from '../utils/http.js';
import { register } from './registry.js';

const SRU = 'https://iss.ndl.go.jp/api/sru/search';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

export async function ndlSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    operation: 'searchRetrieve',
    version: '1.2',
    query: `title="${query}" or creator="${query}"`,
    maximumRecords: String(limit),
    recordSchema: 'dcndl',
  });

  const xml = await fetchText(`${SRU}?${params}`);
  const doc = parser.parse(xml);

  const records = toArray(doc?.['srw:searchRetrieveResponse']?.['srw:records']?.['srw:record']);

  return records.slice(0, limit).map((r: unknown) => {
    const dcndl =
      ((r as Record<string, unknown>)['srw:recordData'] as Record<string, unknown>) ?? {};
    const id = String(
      findDeep(dcndl, 'dcterms:identifier') ?? findDeep(dcndl, 'dc:identifier') ?? '',
    );
    const title = String(findDeep(dcndl, 'dc:title') ?? '');
    const creator = toArray(findDeep(dcndl, 'dc:creator')).map(String);
    const date = String(findDeep(dcndl, 'dcterms:issued') ?? findDeep(dcndl, 'dc:date') ?? '');
    const lang = String(findDeep(dcndl, 'dc:language') ?? '');

    return {
      id,
      source: 'ndl' as const,
      title,
      authors: creator,
      year: date ? parseInt(date, 10) : undefined,
      language: lang || 'ja',
      hasFullText: false,
      previewUrl: id.startsWith('http') ? id : `https://iss.ndl.go.jp/books/${id}`,
    };
  });
}

function toArray(val: unknown): unknown[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function findDeep(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  if (key in record) return record[key];
  for (const v of Object.values(record)) {
    const found = findDeep(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

register('ndl', {
  description:
    'Japan National Diet Library — 350k+ out-of-copyright digitized books. Metadata and discovery; full text via NDL Digital Collections.',
  supportsIngest: false,
  search: ndlSearch,
  async read(id) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: id.startsWith('http') ? id : `https://dl.ndl.go.jp/pid/${id}`,
      note: 'NDL full text is accessible at NDL Digital Collections (dl.ndl.go.jp). Some items require Japanese IP or NDL account.',
    };
  },
});
