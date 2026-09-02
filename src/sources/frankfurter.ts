// Frankfurter: free exchange-rate data from the European Central Bank. No
// API key required. A custom register() rather than defineRest(): search()
// branches between two different endpoints depending on whether the query
// looks like a currency code (or pair) or free text.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.frankfurter.dev/v1';
const CODE = /^[A-Za-z]{3}$/;

interface FrankfurterRatesResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

type FrankfurterCurrencies = Record<string, string>;

function ratesText(rates: Record<string, number>): string {
  return Object.entries(rates)
    .map(([code, rate]) => `${code}: ${rate}`)
    .join(', ');
}

// A query of "USD" or "USD EUR" (base, optionally a target) looks up live
// rates directly; anything else is treated as free text against the
// currency name/code list.
function parseCodeQuery(query: string): { base: string; target?: string } | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return null;
  if (!tokens.every((t) => CODE.test(t))) return null;
  return { base: tokens[0].toUpperCase(), target: tokens[1]?.toUpperCase() };
}

export function normalizeFrankfurterRates(data: FrankfurterRatesResponse): LibraryResult {
  return {
    id: `${data.base}:${data.date}`,
    source: 'frankfurter',
    title: `${data.base} rates ${data.date}`,
    authors: [],
    hasFullText: true,
    description: ratesText(data.rates),
    published: data.date,
  };
}

export function normalizeFrankfurterCurrency(code: string, name: string): LibraryResult {
  return {
    id: code,
    source: 'frankfurter',
    title: `${code}: ${name}`,
    authors: [],
    hasFullText: true,
    description: name,
  };
}

export async function frankfurterSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const codeQuery = parseCodeQuery(query);
  if (codeQuery) {
    const symbols = codeQuery.target ? `&symbols=${codeQuery.target}` : '';
    const data = await fetchJSON<FrankfurterRatesResponse>(
      `${BASE}/latest?base=${codeQuery.base}${symbols}`,
    );
    return [normalizeFrankfurterRates(data)];
  }
  const currencies = await fetchJSON<FrankfurterCurrencies>(`${BASE}/currencies`);
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries(currencies)
    .filter(([code, name]) => {
      if (tokens.length === 0) return true;
      const haystack = `${code} ${name}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    })
    .slice(0, limit)
    .map(([code, name]) => normalizeFrankfurterCurrency(code, name));
}

export async function frankfurterRead(id: string): Promise<ReadResult> {
  const [base, date] = id.includes(':') ? id.split(':') : [id, undefined];
  const path = date ? `/${date}` : '/latest';
  const data = await fetchJSON<FrankfurterRatesResponse>(`${BASE}${path}?base=${base}`);
  return {
    title: `${data.base} rates ${data.date}`,
    authors: [],
    ...truncateText(ratesText(data.rates)),
  };
}

register('frankfurter', {
  description:
    'Frankfurter: free daily exchange rates from the European Central Bank. A query like "USD" or "USD EUR" looks up live rates; anything else searches currency names. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://frankfurter.dev',
  verifiedAt: '2026-09-01',
  search: frankfurterSearch,
  read: frankfurterRead,
});
