import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://catalog.data.gov';

interface DataGovResult {
  title?: string;
  description?: string;
  identifier?: string;
  slug?: string;
  publisher?: string;
  keyword?: string[];
  theme?: string[];
  has_spatial?: boolean;
  last_harvested_date?: string;
  landingPage?: string;
  organization?: {
    name?: string;
    slug?: string;
    organization_type?: string;
  };
  dcat?: {
    accessLevel?: string;
    language?: string[];
    modified?: string;
    issued?: string;
    license?: string;
    landingPage?: string;
  };
}

interface DataGovResponse {
  results: DataGovResult[];
  after?: string;
  sort?: string;
}

export async function dataGovSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    per_page: String(Math.min(limit, 100)),
    sort: 'relevance',
  });

  const data = await fetchJSON<DataGovResponse>(`${BASE}/search?${params}`);

  return (data.results ?? []).slice(0, limit).map((r) => {
    const id = r.identifier ?? r.slug ?? r.title ?? '';
    const landingPage = r.dcat?.landingPage ?? r.landingPage;

    return {
      id,
      source: 'datagov' as const,
      title: r.title ?? id,
      authors: r.publisher ? [r.publisher] : r.organization?.name ? [r.organization.name] : [],
      year: r.dcat?.issued ? parseInt(r.dcat.issued.slice(0, 4), 10) : undefined,
      language: r.dcat?.language?.[0]?.replace('en-US', 'en'),
      subjects: [...(r.keyword ?? []), ...(r.theme ?? [])].slice(0, 5),
      hasFullText: false,
      previewUrl: landingPage ?? `https://catalog.data.gov/dataset/${r.slug ?? id}`,
    };
  });
}

register('datagov', {
  description:
    'Data.gov — US government open data catalog. 300k+ datasets from federal, state, local, and tribal agencies. No key required. Metadata and discovery.',
  supportsIngest: false,
  search: dataGovSearch,
  async read(id) {
    // Try to get the harvest record for full metadata
    const landingPage = id.startsWith('http') ? id : `https://catalog.data.gov/dataset/${id}`;

    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: landingPage,
      note: 'Data.gov is a metadata catalog. Visit externalUrl to access the actual dataset downloads and documentation.',
    };
  },
});
