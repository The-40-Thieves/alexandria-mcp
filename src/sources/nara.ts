import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://catalog.archives.gov/api/v2';

function getKey(): string {
  const key = process.env.NARA_API_KEY;
  if (!key)
    throw new Error(
      'NARA requires NARA_API_KEY. Register a free key at: https://www.archives.gov/research/catalog/help/api ' +
        'then set NARA_API_KEY in your environment.',
    );
  return key;
}

interface NARARecord {
  naId?: number | string;
  title?: string;
  levelOfDescription?: string;
  generalRecordsTypes?: string[];
  scopeAndContentNote?: string;
  productionDates?: Array<{ year?: number; month?: number; day?: number }>;
}

interface NARAHit {
  _source?: { record?: NARARecord };
}

interface NARASearchResponse {
  body?: { hits?: { hits?: NARAHit[] } };
}

function yearOf(rec: NARARecord): number | undefined {
  const y = rec.productionDates?.[0]?.year;
  return typeof y === 'number' ? y : undefined;
}

export function normalizeNara(data: NARASearchResponse, limit: number): LibraryResult[] {
  const hits = data.body?.hits?.hits ?? [];
  return hits.slice(0, limit).flatMap((hit) => {
    const r = hit._source?.record;
    if (!r) return [];
    const naId = r.naId !== undefined ? String(r.naId) : undefined;
    return [
      {
        id: naId ?? '',
        source: 'nara' as const,
        title: r.title ?? naId ?? 'Untitled',
        authors: [],
        year: yearOf(r),
        subjects: [
          ...(r.levelOfDescription ? [r.levelOfDescription] : []),
          ...(r.generalRecordsTypes ?? []),
        ],
        hasFullText: Boolean(r.scopeAndContentNote),
        previewUrl: naId ? `https://catalog.archives.gov/id/${naId}` : undefined,
        description: r.scopeAndContentNote?.slice(0, 300),
      },
    ];
  });
}

export async function naraSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const data = await fetchJSON<NARASearchResponse>(`${BASE}/records/search?${params}`, {
    headers: { 'x-api-key': getKey() },
  });
  return normalizeNara(data, limit);
}

export async function naraRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  // NARA v2 has no dedicated single-record GET; a search filtered to a
  // known naId returns the same hits wrapper as a keyword search.
  const data = await fetchJSON<NARASearchResponse>(
    `${BASE}/records/search?naId=${encodeURIComponent(id)}`,
    { headers: { 'x-api-key': getKey() } },
  );
  const record = data.body?.hits?.hits?.[0]?._source?.record;
  if (!record) throw new Error(`NARA record not found: ${id}`);
  const text = record.scopeAndContentNote || `No description available for NARA record ${id}`;
  return {
    text,
    title: record.title ?? id,
    authors: [],
    year: yearOf(record),
    language: 'en',
  };
}

register('nara', {
  description:
    'US National Archives (NARA) — 32M+ descriptions of historical government records: war diaries, presidential papers, military records, federal agencies. Requires free NARA_API_KEY.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'archives',
  freshness: 'daily',
  homepage: 'https://catalog.archives.gov',
  auth: { type: 'header', env: 'NARA_API_KEY', header: 'x-api-key' },
  search: naraSearch,
  async read(id) {
    const raw = await naraRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
