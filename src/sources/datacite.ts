// DataCite REST API: DOI metadata for research datasets and software
// (Zenodo, Figshare, Dryad, OSF, and more all register their DOIs here).
// Both search and read are a single JSON fetch with synchronous
// normalization, so this fits defineRest directly.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://api.datacite.org';

interface DataciteCreator {
  name?: string;
}
interface DataciteDescription {
  description?: string;
  descriptionType?: string;
}
interface DataciteAttributes {
  doi: string;
  titles?: Array<{ title?: string }>;
  creators?: DataciteCreator[];
  publicationYear?: number;
  language?: string;
  descriptions?: DataciteDescription[];
  types?: { resourceTypeGeneral?: string };
  url?: string;
}
interface DataciteItem {
  id: string;
  attributes: DataciteAttributes;
}
interface DataciteListResponse {
  data: DataciteItem[];
}
interface DataciteGetResponse {
  data: DataciteItem;
}

function creatorNames(creators?: DataciteCreator[]): string[] {
  return (creators ?? []).map((c) => c.name).filter((n): n is string => Boolean(n));
}

function abstractOf(attrs: DataciteAttributes): string | undefined {
  const abstract = attrs.descriptions?.find((d) => d.descriptionType === 'Abstract');
  return (abstract ?? attrs.descriptions?.[0])?.description;
}

export function normalizeDatacite(item: DataciteItem): LibraryResult {
  const a = item.attributes;
  return {
    id: a.doi,
    source: 'datacite',
    title: a.titles?.[0]?.title || 'Untitled',
    authors: creatorNames(a.creators),
    year: a.publicationYear,
    language: a.language,
    subjects: a.types?.resourceTypeGeneral ? [a.types.resourceTypeGeneral] : undefined,
    hasFullText: false,
    previewUrl: a.url || `https://doi.org/${a.doi}`,
    description: abstractOf(a)?.slice(0, 300),
  };
}

defineRest<DataciteListResponse>({
  name: 'datacite',
  description:
    'DataCite: DOI metadata for research datasets and software (Zenodo, Figshare, Dryad, OSF, and more all register here) - one source for the whole data-repository DOI tier. No API key required (3,000 req/5min/IP).',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://datacite.org',
  supportsIngest: true,
  verifiedAt: '2026-09-03',
  // 3,000 req / 5 min / IP == 10 rps.
  pacing: { minIntervalMs: 100 },
  search: {
    url: (q, limit) => `${BASE}/dois?query=${encodeURIComponent(q)}&page[size]=${limit}`,
    pick: (raw) => raw.data ?? [],
    normalize: normalizeDatacite,
  },
  read: {
    url: (id) => `${BASE}/dois/${encodeURIComponent(id)}`,
    normalize: (raw: DataciteGetResponse, id: string) => {
      const a = raw.data?.attributes;
      if (!a) throw new Error(`DataCite record not found: ${id}`);
      const text = abstractOf(a) || `No abstract available for ${id}.`;
      return {
        title: a.titles?.[0]?.title || id,
        authors: creatorNames(a.creators),
        year: a.publicationYear,
        language: a.language,
        doi: a.doi,
        ...truncateText(text),
      };
    },
  },
});
