import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE_URL = 'https://api.repository.cam.ac.uk/server/api';

type DSMeta = Record<string, Array<{ value: string; language?: string | null }>>;

interface DSItem {
  id: string;
  name?: string;
  type?: string;
  metadata?: DSMeta;
}

interface DSSearchResult {
  _embedded?: { indexableObject?: DSItem };
}

interface DSSearchResponse {
  _embedded?: {
    searchResult?: {
      _embedded?: { objects?: DSSearchResult[] };
      page?: { totalElements?: number };
    };
  };
}

function getMeta(meta: DSMeta | undefined, key: string): string[] {
  return (meta?.[key] || []).map((v) => v.value).filter(Boolean);
}

function firstMeta(meta: DSMeta | undefined, key: string): string {
  return getMeta(meta, key)[0] || '';
}

export async function apolloSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<DSSearchResponse>(
    `${BASE_URL}/discover/search/objects?query=${encodeURIComponent(query)}&size=${limit}&embed=indexableObject&dsoType=item`,
  );
  const objects = data._embedded?.searchResult?._embedded?.objects || [];
  return objects.flatMap((o) => {
    const item = o._embedded?.indexableObject;
    if (!item) return [];
    const meta = item.metadata || {};
    const dateStr = firstMeta(meta, 'dc.date.issued') || firstMeta(meta, 'dc.date.available');
    const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
    const handle = firstMeta(meta, 'dc.identifier.uri');
    const result: LibraryResult = {
      id: item.id,
      source: 'apollo',
      title: firstMeta(meta, 'dc.title') || item.name || 'Untitled',
      authors: [...getMeta(meta, 'dc.contributor.author'), ...getMeta(meta, 'dc.creator')],
      year: Number.isNaN(year as number) ? undefined : year,
      language: firstMeta(meta, 'dc.language.iso').replace(/_.*/, '') || undefined,
      subjects: getMeta(meta, 'dc.subject'),
      hasFullText: Boolean(firstMeta(meta, 'dc.description.abstract')),
      previewUrl: handle || `https://www.repository.cam.ac.uk/items/${item.id}`,
      description: firstMeta(meta, 'dc.description.abstract')?.substring(0, 300) || undefined,
    };
    return [result];
  });
}

export async function apolloRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const item = await fetchJSON<DSItem>(`${BASE_URL}/core/items/${id}`);
  const meta = item.metadata || {};
  const dateStr = firstMeta(meta, 'dc.date.issued') || firstMeta(meta, 'dc.date.available');
  const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
  const abstract = firstMeta(meta, 'dc.description.abstract');
  return {
    text: abstract || `No abstract available for Cambridge Apollo item ${id}`,
    title: firstMeta(meta, 'dc.title') || item.name || id,
    authors: [...getMeta(meta, 'dc.contributor.author'), ...getMeta(meta, 'dc.creator')],
    year: Number.isNaN(year as number) ? undefined : year,
    language: firstMeta(meta, 'dc.language.iso').replace(/_.*/, '') || undefined,
  };
}

register('apollo', {
  description:
    'Cambridge Apollo — Cambridge University institutional repository. Theses, working papers, preprints, and faculty research. DSpace REST API v7, no auth required.',
  supportsIngest: true,
  search: apolloSearch,
  async read(id) {
    const raw = await apolloRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
