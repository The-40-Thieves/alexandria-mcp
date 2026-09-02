// Twelve Data: stock, ETF, and forex symbol search plus a daily time series
// read. Requires TWELVEDATA_API_KEY (query param apikey).
import type { LibraryResult, ReadResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.twelvedata.com';

interface TwelveDataSymbol {
  symbol: string;
  instrument_name: string;
  exchange?: string;
  country?: string;
}

interface TwelveDataSearchResponse {
  data?: TwelveDataSymbol[];
}

interface TwelveDataTimeSeriesValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TwelveDataTimeSeriesResponse {
  values?: TwelveDataTimeSeriesValue[];
  status?: string;
  message?: string;
}

export function normalizeTwelveData(item: TwelveDataSymbol): LibraryResult | null {
  if (!item.symbol) return null;
  return {
    id: `${item.symbol}:${item.exchange ?? ''}`,
    source: 'twelvedata',
    title: item.instrument_name || item.symbol,
    authors: [],
    hasFullText: true,
    description: item.country,
  };
}

defineRest<TwelveDataSearchResponse>({
  name: 'twelvedata',
  description:
    'Twelve Data: stock, ETF, and forex symbol search across global exchanges, with a daily time series read. Requires free TWELVEDATA_API_KEY.',
  cluster: 'markets',
  freshness: 'realtime',
  homepage: 'https://twelvedata.com',
  supportsIngest: false,
  auth: { type: 'query', env: 'TWELVEDATA_API_KEY', param: 'apikey' },
  pacing: { minIntervalMs: 8000, dailyCap: 750 },
  search: {
    url: (q, limit) => `${BASE}/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=${limit}`,
    pick: (raw) => raw.data ?? [],
    normalize: normalizeTwelveData,
  },
  read: {
    url: (id) => {
      const symbol = id.split(':')[0];
      return `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=30`;
    },
    normalize: (raw: TwelveDataTimeSeriesResponse, id: string): ReadResult => {
      if (!raw.values || raw.values.length === 0) {
        return {
          title: id,
          authors: [],
          ...truncateText(raw.message || `No time series data found for ${id}.`),
        };
      }
      const header = 'date       open      high      low       close     volume';
      const rows = raw.values.map(
        (v) =>
          `${v.datetime}  ${v.open.padEnd(9)} ${v.high.padEnd(9)} ${v.low.padEnd(9)} ${v.close.padEnd(9)} ${v.volume ?? ''}`,
      );
      return { title: id, authors: [], ...truncateText([header, ...rows].join('\n')) };
    },
  },
});
