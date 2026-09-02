import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

// DPLA's previously-available keyless allowance (500 req/day) is gone —
// unauthenticated calls now return 403 invalid_api_key (confirmed 2026-09).
const DPLA = 'https://api.dp.la/v2';

type DPLADate = { begin?: string } | Array<{ begin?: string }>;

interface DPLADoc {
  id: string;
  sourceResource?: {
    title?: string[];
    creator?: string[];
    // DPLA's schema documents `date` as a single object, but some
    // harvested records carry an array — accept either.
    date?: DPLADate;
    subject?: Array<{ name: string }>;
    language?: Array<{ name: string }>;
    type?: string[];
  };
  isShownAt?: string;
}

interface DPLAResponse {
  count: number;
  docs: DPLADoc[];
}

function getKey(): string {
  const key = process.env.DPLA_API_KEY;
  if (!key)
    throw new Error(
      'DPLA requires DPLA_API_KEY. Register a free key at: https://pro.dp.la/developers/policies#getting-a-key ' +
        'then set DPLA_API_KEY in your environment.',
    );
  return key;
}

function dateBegin(date?: DPLADate): string | undefined {
  if (!date) return undefined;
  return Array.isArray(date) ? date[0]?.begin : date.begin;
}

export function normalizeDpla(data: DPLAResponse, limit: number): LibraryResult[] {
  return (data.docs ?? []).slice(0, limit).map((doc) => {
    const sr = doc.sourceResource ?? {};
    const begin = dateBegin(sr.date);
    return {
      id: doc.id,
      source: 'dpla' as const,
      title: sr.title?.[0] ?? doc.id,
      authors: sr.creator ?? [],
      year: begin ? parseInt(begin, 10) : undefined,
      language: sr.language?.[0]?.name,
      subjects: (sr.subject ?? []).slice(0, 5).map((s) => s.name),
      hasFullText: false,
      previewUrl: doc.isShownAt,
    };
  });
}

export async function dplaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    page_size: String(limit),
    api_key: getKey(),
  });
  const data = await fetchJSON<DPLAResponse>(`${DPLA}/items?${params}`);
  return normalizeDpla(data, limit);
}

register('dpla', {
  description:
    'Digital Public Library of America — 17M+ items from US libraries, archives, and museums. Metadata aggregator. Requires free DPLA_API_KEY.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'culture',
  freshness: 'daily',
  homepage: 'https://dp.la',
  verifiedAt: '2026-09-01',
  auth: { type: 'query', env: 'DPLA_API_KEY', param: 'api_key' },
  search: dplaSearch,
  async read(id) {
    const params = new URLSearchParams({ api_key: getKey() });
    const data = await fetchJSON<DPLAResponse>(`${DPLA}/items/${id}?${params}`);
    const doc = data.docs?.[0];
    const sr = doc?.sourceResource ?? {};
    const begin = dateBegin(sr.date);
    return {
      title: sr.title?.[0] ?? id,
      authors: sr.creator ?? [],
      year: begin ? parseInt(begin, 10) : undefined,
      metadataOnly: true,
      externalUrl: doc?.isShownAt,
      note: 'DPLA aggregates metadata from partner institutions. Visit externalUrl for the source item.',
    };
  },
});
