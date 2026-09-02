import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const BASE = 'https://catalog.data.gov';

interface DataGovResult {
  title?: string;
  slug?: string;
  identifier?: string;
  publisher?: string;
  keyword?: string[];
  theme?: string[];
  organization?: { name?: string };
  dcat?: {
    landingPage?: string;
    issued?: string;
    language?: string[] | string;
  };
}

interface DataGovResponse {
  results?: DataGovResult[];
  hits?: DataGovResult[];
}

export function normalizeDataGov(data: DataGovResponse, limit: number): LibraryResult[] {
  const items = data.results ?? data.hits ?? [];
  return items.slice(0, limit).map((r) => {
    const id = r.slug ?? r.identifier ?? r.title ?? '';
    const language = Array.isArray(r.dcat?.language) ? r.dcat?.language[0] : r.dcat?.language;
    return {
      id,
      source: 'datagov' as const,
      title: r.title ?? id,
      authors: r.publisher ? [r.publisher] : r.organization?.name ? [r.organization.name] : [],
      year: r.dcat?.issued ? parseInt(r.dcat.issued.slice(0, 4), 10) : undefined,
      language: language?.replace('en-US', 'en'),
      subjects: [...(r.keyword ?? []), ...(r.theme ?? [])].slice(0, 5),
      hasFullText: false,
      previewUrl: r.dcat?.landingPage ?? `https://catalog.data.gov/dataset/${r.slug ?? id}`,
    };
  });
}

export async function dataGovSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ q: query, size: String(Math.min(limit, 100)) });
  const data = await fetchJSON<DataGovResponse>(`${BASE}/search?${params}`);
  return normalizeDataGov(data, limit);
}

register('datagov', {
  description:
    'Data.gov — US government open data catalog. 300k+ datasets from federal, state, local, and tribal agencies. No key required. Metadata and discovery.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://catalog.data.gov',
  verifiedAt: '2026-09-01',
  search: dataGovSearch,
  async read(id) {
    const landingPage = id.startsWith('http') ? id : `https://catalog.data.gov/dataset/${id}`;
    const data = await fetchJSON<DataGovResponse>(`${BASE}/api/dataset/${id}`).catch(
      () => undefined,
    );
    const r = data?.results?.[0];

    return {
      title: r?.title ?? id,
      authors: r?.publisher ? [r.publisher] : [],
      metadataOnly: true,
      externalUrl: r?.dcat?.landingPage ?? landingPage,
      note: 'Data.gov is a metadata catalog. Visit externalUrl to access the actual dataset downloads and documentation.',
    };
  },
});
