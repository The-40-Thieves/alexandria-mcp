// CoinGecko: cryptocurrency search plus a per-coin summary read. Works
// keyless (rate limited); COINGECKO_API_KEY, if present, is sent as the
// x-cg-demo-api-key header for a higher rate limit, the same optional-key
// convention as nvd.ts.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.coingecko.com/api/v3';

interface CoingeckoCoin {
  id: string;
  name: string;
  symbol: string;
}

interface CoingeckoSearchResponse {
  coins?: CoingeckoCoin[];
}

interface CoingeckoCoinDetail {
  id: string;
  name: string;
  symbol: string;
  market_data?: {
    current_price?: Record<string, number>;
    market_cap?: Record<string, number>;
  };
  description?: { en?: string };
}

const apiKey = process.env.COINGECKO_API_KEY;
const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : undefined;

export function normalizeCoingecko(coin: CoingeckoCoin): LibraryResult {
  return {
    id: coin.id,
    source: 'coingecko',
    title: `${coin.name} (${coin.symbol.toUpperCase()})`,
    authors: [],
    hasFullText: true,
  };
}

export async function coingeckoSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<CoingeckoSearchResponse>(
    `${BASE}/search?query=${encodeURIComponent(query)}`,
    { headers },
  );
  return (data.coins ?? []).slice(0, limit).map(normalizeCoingecko);
}

export async function coingeckoRead(id: string): Promise<ReadResult> {
  const coin = await fetchJSON<CoingeckoCoinDetail>(
    `${BASE}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&community_data=false&developer_data=false`,
    { headers },
  );
  const price = coin.market_data?.current_price?.usd;
  const marketCap = coin.market_data?.market_cap?.usd;
  const lines = [
    `${coin.name} (${coin.symbol.toUpperCase()})`,
    price !== undefined ? `Price (USD): $${price}` : undefined,
    marketCap !== undefined ? `Market cap (USD): $${marketCap}` : undefined,
    '',
    coin.description?.en || 'No description available.',
  ].filter((l): l is string => l !== undefined);
  return { title: coin.name || id, authors: [], ...truncateText(lines.join('\n')) };
}

register('coingecko', {
  description:
    'CoinGecko: cryptocurrency search across thousands of coins and tokens, with a price/market-cap/description summary read. Works keyless; set COINGECKO_API_KEY for a higher rate limit.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'markets',
  freshness: 'realtime',
  homepage: 'https://www.coingecko.com',
  verifiedAt: '2026-09-01',
  pacing: { minIntervalMs: 700 },
  search: coingeckoSearch,
  read: coingeckoRead,
});
