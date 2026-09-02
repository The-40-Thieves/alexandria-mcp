// openFDA drug enforcement (recalls) search. Works keyless (rate limited);
// OPENFDA_API_KEY, if present, is sent as the api_key query param for a
// higher rate limit, the same optional-key convention as nvd.ts.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.fda.gov/drug/enforcement.json';

interface OpenFdaResult {
  recall_number: string;
  product_description?: string;
  reason_for_recall?: string;
  report_date?: string;
  recalling_firm?: string;
}

interface OpenFdaResponse {
  results?: OpenFdaResult[];
}

const apiKey = process.env.OPENFDA_API_KEY;

function yearOf(date: string | undefined): number | undefined {
  if (!date || date.length < 4) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeOpenFda(item: OpenFdaResult): LibraryResult | null {
  if (!item.recall_number) return null;
  return {
    id: item.recall_number,
    source: 'openfda',
    title: item.product_description || item.recall_number,
    authors: [],
    year: yearOf(item.report_date),
    hasFullText: Boolean(item.reason_for_recall),
    description: item.reason_for_recall,
    published: item.report_date,
  };
}

function url(search: string, limit: number): string {
  const params = new URLSearchParams({ search, limit: String(limit) });
  if (apiKey) params.set('api_key', apiKey);
  return `${BASE}?${params.toString()}`;
}

export async function openfdaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<OpenFdaResponse>(url(`product_description:"${query}"`, limit));
  const results: LibraryResult[] = [];
  for (const item of data.results ?? []) {
    const normalized = normalizeOpenFda(item);
    if (normalized) results.push(normalized);
  }
  return results;
}

export async function openfdaRead(id: string): Promise<ReadResult> {
  const data = await fetchJSON<OpenFdaResponse>(url(`recall_number:"${id}"`, 1));
  const item = data.results?.[0];
  if (!item) {
    return { title: id, authors: [], ...truncateText(`No recall record found for ${id}.`) };
  }
  const text = [
    item.product_description,
    item.recalling_firm ? `Recalling firm: ${item.recalling_firm}` : undefined,
    item.reason_for_recall ? `Reason: ${item.reason_for_recall}` : undefined,
  ]
    .filter((l): l is string => Boolean(l))
    .join('\n');
  return {
    title: item.product_description || id,
    authors: [],
    year: yearOf(item.report_date),
    ...truncateText(text || `No details available for ${id}.`),
  };
}

register('openfda', {
  description:
    'openFDA drug enforcement reports: FDA drug recalls, searchable by product description. Works keyless; set OPENFDA_API_KEY for a higher rate limit.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://open.fda.gov',
  verifiedAt: '2026-09-01',
  // Raises the openFDA rate limit; the source works without one.
  optionalEnv: ['OPENFDA_API_KEY'],
  pacing: { minIntervalMs: 300 },
  search: openfdaSearch,
  read: openfdaRead,
});
