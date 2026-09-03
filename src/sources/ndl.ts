import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { asArray, findDeep, parseXml, textOf } from '../utils/xml.ts';
import { register } from './registry.ts';

const SRU = 'https://ndlsearch.ndl.go.jp/api/sru';

// NDL Search's SRU endpoint: recordSchema=dcndl_simple (as documented in
// some older references) returns "illegal recordSchema value" as of
// 2026-09; "dcndl" is the schema that actually works. recordPacking=xml
// (rather than the default "string", which double-encodes recordData as
// escaped text) gets real nested XML that fast-xml-parser can walk.
export async function ndlSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    operation: 'searchRetrieve',
    version: '1.2',
    query: `anywhere="${query}"`,
    maximumRecords: String(limit),
    recordSchema: 'dcndl',
    recordPacking: 'xml',
  });
  const xml = await fetchText(`${SRU}?${params}`);
  return normalizeNdl(xml, limit);
}

// dcndl records nest the fields we want at varying depths (and a record
// can repeat dcndl:BibResource as a near-empty stub), so findDeep's
// document-wide search for the first occurrence is more robust than a
// fixed path. findDeep/textOf are the shared xml.ts versions; this stays
// local since it's ndl's own dc:title/rdf:value fallback logic.
function titleOf(record: Record<string, unknown>): string {
  const flat = textOf(findDeep(record, 'dcterms:title'));
  if (flat) return flat;
  const dcTitle = findDeep(record, 'dc:title');
  const value = findDeep(dcTitle, 'rdf:value');
  return textOf(value);
}

export function normalizeNdl(xml: string, limit: number): LibraryResult[] {
  const doc = parseXml<Record<string, unknown>>(xml);
  const root = (doc.searchRetrieveResponse ?? doc) as Record<string, unknown>;
  const records = asArray((root.records as Record<string, unknown> | undefined)?.record);

  return records.slice(0, limit).map((r) => {
    const rec = r as Record<string, unknown>;
    const rdf = findDeep(rec.recordData, 'rdf:RDF') as Record<string, unknown> | undefined;
    const admin = findDeep(rdf, 'dcndl:BibAdminResource') as Record<string, unknown> | undefined;
    const id = String((admin?.['@_rdf:about'] as string | undefined) ?? '');

    const title = titleOf(rdf ?? {});
    const creators = asArray(findDeep(rdf, 'dc:creator')).map(textOf).filter(Boolean);
    const issued = textOf(findDeep(rdf, 'dcterms:issued')) || textOf(findDeep(rdf, 'dcterms:date'));
    const language = textOf(findDeep(rdf, 'dcterms:language'));

    return {
      id,
      source: 'ndl' as const,
      title,
      authors: creators,
      year: /^\d{4}/.test(issued) ? parseInt(issued.slice(0, 4), 10) : undefined,
      language: language || 'ja',
      hasFullText: false,
      previewUrl: id || undefined,
    };
  });
}

register('ndl', {
  description:
    'Japan National Diet Library — 350k+ out-of-copyright digitized books. Metadata and discovery; full text via NDL Digital Collections.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'culture',
  freshness: 'daily',
  homepage: 'https://ndlsearch.ndl.go.jp',
  verifiedAt: '2026-09-01',
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
