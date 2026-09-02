// US Census Bureau dataset catalog: a single JSON document (no per-query
// search API), downloaded once per process and filtered client-side by
// token match, the same static-download convention as kev.ts and attack.ts.
// CENSUS_API_KEY is optional and not needed for this catalog metadata.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const URL = 'https://api.census.gov/data.json';
const TIMEOUT_MS = 30000;

interface CensusDataset {
  c_dataset: string[];
  title: string;
  description?: string;
  modified?: string;
  c_documentationLink?: string;
}

interface CensusCatalog {
  dataset: CensusDataset[];
}

let cached: Promise<CensusCatalog> | undefined;

function download(): Promise<CensusCatalog> {
  if (!cached) {
    cached = fetchJSON<CensusCatalog>(URL, {}, TIMEOUT_MS).catch((err) => {
      cached = undefined; // let a later call retry after a failed download
      throw err;
    });
  }
  return cached;
}

function datasetId(d: CensusDataset): string {
  return (d.c_dataset ?? []).join('/');
}

function yearOf(modified: string | undefined): number | undefined {
  if (!modified) return undefined;
  const year = Number(modified.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

function matches(d: CensusDataset, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${d.title} ${d.description ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizeCensus(d: CensusDataset): LibraryResult | null {
  const id = datasetId(d);
  if (!id) return null;
  return {
    id,
    source: 'census',
    title: d.title,
    authors: [],
    year: yearOf(d.modified),
    hasFullText: false,
    description: d.description?.slice(0, 300),
    previewUrl: d.c_documentationLink,
  };
}

export async function censusSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const catalog = await download();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results: LibraryResult[] = [];
  for (const d of catalog.dataset) {
    if (!matches(d, tokens)) continue;
    const normalized = normalizeCensus(d);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

export async function censusRead(id: string): Promise<ReadResult> {
  const catalog = await download();
  const d = catalog.dataset.find((item) => datasetId(item) === id);
  if (!d) throw new Error(`census: dataset ${id} not found in the catalog`);
  return {
    title: d.title,
    authors: [],
    year: yearOf(d.modified),
    metadataOnly: true,
    externalUrl: d.c_documentationLink,
    note: d.description ?? 'No description available.',
  };
}

register('census', {
  description:
    'US Census Bureau dataset catalog: metadata for every dataset the Census Bureau API exposes (ACS, decennial census, economic surveys, and more). Downloaded once per process and filtered client-side; there is no per-query search API. CENSUS_API_KEY is optional and not required for this catalog.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://www.census.gov/data/developers/data-sets.html',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: censusSearch,
  read: censusRead,
});
