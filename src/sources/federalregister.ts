// Federal Register: the daily journal of the US federal government. No API
// key required. A custom register() rather than defineRest(): read() is
// metadata only until the fetchTier web-fetch tier lands in Stage 6 (the
// same TODO convention used by mdn.ts, nhk.ts and kinds/rss.ts), since a
// Federal Register document body is an HTML page, not a JSON API.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://www.federalregister.gov/api/v1';

interface FederalRegisterDoc {
  document_number: string;
  title: string;
  publication_date?: string;
  html_url?: string;
  abstract?: string;
}

interface FederalRegisterSearchResponse {
  results?: FederalRegisterDoc[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeFederalRegister(item: FederalRegisterDoc): LibraryResult {
  return {
    id: item.document_number,
    source: 'federalregister',
    title: item.title,
    authors: [],
    year: yearOf(item.publication_date),
    hasFullText: false,
    description: item.abstract,
    published: item.publication_date,
    url: item.html_url,
  };
}

export async function federalRegisterSearch(
  query: string,
  limit: number,
): Promise<LibraryResult[]> {
  const data = await fetchJSON<FederalRegisterSearchResponse>(
    `${BASE}/documents.json?per_page=${limit}&conditions%5Bterm%5D=${encodeURIComponent(query)}`,
  );
  return (data.results ?? []).map(normalizeFederalRegister);
}

// TODO(stage-6): fetchTier
export async function federalRegisterRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    externalUrl: `https://www.federalregister.gov/documents/${id}`,
    note: 'Full-text fetch for Federal Register arrives in a later stage; this is metadata only.',
  };
}

register('federalregister', {
  description:
    'Federal Register: the daily journal of the US federal government (rules, proposed rules, and notices). No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://www.federalregister.gov',
  verifiedAt: '2026-09-01',
  search: federalRegisterSearch,
  read: federalRegisterRead,
});
