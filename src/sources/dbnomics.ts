// DBnomics: an aggregator of macroeconomic datasets from statistical
// agencies worldwide. No API key required.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.db.nomics.world/v22';

interface DbnomicsDoc {
  provider_code: string;
  code: string;
  name?: string;
  provider_name?: string;
}

interface DbnomicsSearchResponse {
  results?: { docs?: DbnomicsDoc[] };
}

interface DbnomicsSeriesResponse {
  series?: {
    docs?: Array<{
      series_code?: string;
      series_name?: string;
      period?: string[];
      value?: number[];
    }>;
  };
}

export function normalizeDbnomics(doc: DbnomicsDoc): LibraryResult {
  return {
    id: `${doc.provider_code}/${doc.code}`,
    source: 'dbnomics',
    title: doc.name || doc.code,
    authors: [],
    hasFullText: true,
    description: doc.provider_name,
  };
}

defineRest<DbnomicsSearchResponse>({
  name: 'dbnomics',
  description:
    'DBnomics: an aggregator of macroeconomic and statistical datasets from central banks, statistical agencies, and international organizations worldwide. No API key required.',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://db.nomics.world',
  supportsIngest: false,
  search: {
    url: (q, limit) => `${BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    pick: (raw) => raw.results?.docs ?? [],
    normalize: normalizeDbnomics,
  },
  read: {
    url: (id) => {
      const slashIndex = id.indexOf('/');
      const provider = id.slice(0, slashIndex);
      const dataset = id.slice(slashIndex + 1);
      return `${BASE}/series/${provider}/${dataset}?observations=1&limit=5&format=json`;
    },
    normalize: (raw: DbnomicsSeriesResponse, id: string) => {
      const series = raw.series?.docs?.[0];
      if (!series || !series.period?.length) {
        return { title: id, authors: [], ...truncateText(`No series data found for ${id}.`) };
      }
      const rows = series.period.map((p, i) => `${p}: ${series.value?.[i]}`);
      return {
        title: series.series_name || id,
        authors: [],
        ...truncateText(rows.join('\n')),
      };
    },
  },
});
