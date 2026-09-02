// FRED: the Federal Reserve Bank of St. Louis's economic data API. Requires
// FRED_API_KEY.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.stlouisfed.org/fred';

interface FredSeries {
  id: string;
  title: string;
  observation_end?: string;
  notes?: string;
}

interface FredSearchResponse {
  seriess?: FredSeries[];
}

interface FredObservation {
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeFred(series: FredSeries): LibraryResult {
  return {
    id: series.id,
    source: 'fred',
    title: series.title,
    authors: [],
    year: yearOf(series.observation_end),
    hasFullText: true,
    description: series.notes,
  };
}

defineRest<FredSearchResponse>({
  name: 'fred',
  description:
    "FRED: the Federal Reserve Bank of St. Louis's economic data API, hundreds of thousands of US and international time series. Requires free FRED_API_KEY.",
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://fred.stlouisfed.org',
  supportsIngest: false,
  auth: { type: 'query', env: 'FRED_API_KEY', param: 'api_key' },
  search: {
    url: (q, limit) =>
      `${BASE}/series/search?search_text=${encodeURIComponent(q)}&limit=${limit}&file_type=json`,
    pick: (raw) => raw.seriess ?? [],
    normalize: normalizeFred,
  },
  read: {
    url: (id) =>
      `${BASE}/series/observations?series_id=${encodeURIComponent(id)}&limit=60&sort_order=desc&file_type=json`,
    normalize: (raw: FredObservationsResponse, id: string) => {
      const observations = raw.observations ?? [];
      const text = observations.length
        ? observations.map((o) => `${o.date}: ${o.value}`).join('\n')
        : `No observations found for series ${id}.`;
      return { title: id, authors: [], ...truncateText(text) };
    },
  },
});
