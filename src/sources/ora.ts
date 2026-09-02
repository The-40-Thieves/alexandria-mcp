import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE_URL = 'https://ora.ox.ac.uk';

// ORA's public JSON is JSON:API-flavoured: most fields are wrapped as
// { attributes: { value: [...] } } "document_value" nodes rather than plain
// scalars.
interface ORADocumentValue {
  attributes?: { value?: Array<string | number> };
}

interface ORAAttributes {
  title?: string;
  index_authors?: ORADocumentValue;
  rights_copyright_date?: ORADocumentValue;
  abstract?: ORADocumentValue;
  type_of_work?: ORADocumentValue;
}

interface ORAObject {
  id: string;
  attributes?: ORAAttributes;
}

interface ORASearchResponse {
  data?: ORAObject[];
}

interface ORAReadResponse {
  data?: ORAObject;
}

function docValues(dv?: ORADocumentValue): Array<string | number> {
  return dv?.attributes?.value ?? [];
}

function docText(dv?: ORADocumentValue): string {
  return String(docValues(dv)[0] ?? '');
}

// index_authors comes back as one comma-joined string per contributing
// group (e.g. "Park, W, Song, J") rather than a clean per-author array;
// callers get it back as-is via authors[0] since ORA doesn't expose a
// reliably splittable structure.
function authorsOf(attrs?: ORAAttributes): string[] {
  const values = docValues(attrs?.index_authors).map(String);
  return values.length ? values : [];
}

export function normalizeOra(data: ORASearchResponse, limit: number): LibraryResult[] {
  return (data.data ?? []).slice(0, limit).map((item) => {
    const attrs = item.attributes ?? {};
    const yearRaw = docValues(attrs.rights_copyright_date)[0];
    const year = typeof yearRaw === 'number' ? yearRaw : undefined;
    return {
      id: item.id,
      source: 'ora' as const,
      title: attrs.title ?? item.id,
      authors: authorsOf(attrs),
      year,
      hasFullText: false,
      previewUrl: `${BASE_URL}/objects/${item.id}`,
    };
  });
}

export async function oraSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', per_page: String(limit) });
  const data = await fetchJSON<ORASearchResponse>(`${BASE_URL}/objects?${params}`);
  return normalizeOra(data, limit);
}

export async function oraRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
}> {
  const data = await fetchJSON<ORAReadResponse>(`${BASE_URL}/objects/${id}?format=json`);
  const attrs = data.data?.attributes;
  const text = docText(attrs?.abstract) || `No abstract available for Oxford ORA record ${id}`;
  return {
    text,
    title: attrs?.title ?? id,
    authors: authorsOf(attrs),
  };
}

register('ora', {
  description:
    'Oxford ORA: Oxford University Research Archive. Oxford theses, preprints, working papers, and the Oxford Text Archive (classical texts, TEI/XML). No auth required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://ora.ox.ac.uk',
  verifiedAt: '2026-09-01',
  search: oraSearch,
  async read(id) {
    const raw = await oraRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
