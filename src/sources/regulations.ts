// Regulations.gov API v4: US federal rulemaking dockets and public comment
// documents. page[size] has a minimum of 5 (confirmed live: a smaller
// value 400s "Page size parameter must be a positive number of 5 or
// greater"), so the url builder floors the requested limit at 5.
//
// Shares the api.data.gov key family with GovInfo and Congress (see
// congress.ts): DATA_GOV_API_KEY is read first, GOVINFO_API_KEY second, so
// an owner who only registered a GovInfo key still gets Regulations. A
// custom register() rather than defineRest(), since AuthSpec only carries
// one env var (envs?: string[] is deferred, not added in this stage); hidden
// is set explicitly to reflect the two-env fallback the single-env
// isConfigured() check can't express.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.regulations.gov/v4';

function key(): string {
  const k = process.env.DATA_GOV_API_KEY || process.env.GOVINFO_API_KEY;
  if (!k) throw new Error('regulations requires DATA_GOV_API_KEY (or GOVINFO_API_KEY)');
  return k;
}

interface RegulationsAttributes {
  title?: string;
  postedDate?: string;
  documentType?: string;
  docketId?: string;
}

interface RegulationsDocument {
  id: string;
  attributes?: RegulationsAttributes;
}

interface RegulationsSearchResponse {
  data?: RegulationsDocument[];
}

interface RegulationsItemResponse {
  data?: RegulationsDocument;
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeRegulations(item: RegulationsDocument): LibraryResult {
  return {
    id: item.id,
    source: 'regulations',
    title: item.attributes?.title || item.id,
    authors: [],
    year: yearOf(item.attributes?.postedDate),
    hasFullText: false,
    published: item.attributes?.postedDate,
    url: `https://www.regulations.gov/document/${item.id}`,
  };
}

export async function regulationsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const apiKey = key();
  const data = await fetchJSON<RegulationsSearchResponse>(
    `${BASE}/documents?filter%5BsearchTerm%5D=${encodeURIComponent(query)}&page%5Bsize%5D=${Math.max(limit, 5)}&api_key=${apiKey}`,
  );
  return (data.data ?? []).map(normalizeRegulations);
}

export async function regulationsRead(id: string): Promise<ReadResult> {
  const apiKey = key();
  const data = await fetchJSON<RegulationsItemResponse>(
    `${BASE}/documents/${encodeURIComponent(id)}?api_key=${apiKey}`,
  );
  const item = data.data;
  if (!item) {
    return { title: id, authors: [], ...truncateText(`No document found for ${id}.`) };
  }
  const text = [
    item.attributes?.title,
    item.attributes?.documentType ? `Type: ${item.attributes.documentType}` : undefined,
    item.attributes?.docketId ? `Docket: ${item.attributes.docketId}` : undefined,
  ]
    .filter((l): l is string => Boolean(l))
    .join('\n');
  return {
    title: item.attributes?.title || id,
    authors: [],
    year: yearOf(item.attributes?.postedDate),
    ...truncateText(text || `No details available for ${id}.`),
  };
}

register('regulations', {
  description:
    'Regulations.gov API v4: US federal rulemaking dockets and public comment documents. Shares the api.data.gov key family: reads DATA_GOV_API_KEY first, GOVINFO_API_KEY second.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://www.regulations.gov',
  auth: { type: 'query', env: 'DATA_GOV_API_KEY', param: 'api_key' },
  hidden: !(process.env.DATA_GOV_API_KEY || process.env.GOVINFO_API_KEY),
  search: regulationsSearch,
  read: regulationsRead,
});
