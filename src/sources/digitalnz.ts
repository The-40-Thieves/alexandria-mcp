import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const API = 'https://api.digitalnz.org/v3';

interface DNZRecord {
  id: number | string;
  title?: string;
  creator?: string[];
  date?: string[];
  subject?: string[];
  language?: string[];
  landing_url?: string;
}

interface DNZResponse {
  search?: { results?: DNZRecord[] };
}

export function normalizeDigitalNz(data: DNZResponse, limit: number): LibraryResult[] {
  return (data.search?.results ?? []).slice(0, limit).map((r) => ({
    id: String(r.id),
    source: 'digitalnz' as const,
    title: r.title ?? String(r.id),
    authors: r.creator ?? [],
    year: r.date?.[0] ? parseInt(r.date[0].slice(0, 4), 10) : undefined,
    language: r.language?.[0],
    subjects: (r.subject ?? []).slice(0, 5),
    hasFullText: false,
    previewUrl: r.landing_url,
  }));
}

export async function digitalnzSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ text: query, per_page: String(limit) });
  const apiKey = process.env.DIGITALNZ_API_KEY;
  if (apiKey) params.set('api_key', apiKey);
  const data = await fetchJSON<DNZResponse>(`${API}/records.json?${params}`);
  return normalizeDigitalNz(data, limit);
}

register('digitalnz', {
  description:
    'DigitalNZ — New Zealand digital heritage including Māori and Pacific content. Keyless (rate-limited); set DIGITALNZ_API_KEY for a higher limit.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'culture',
  freshness: 'daily',
  homepage: 'https://digitalnz.org',
  verifiedAt: '2026-09-01',
  search: digitalnzSearch,
  async read(id) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: `https://digitalnz.org/records/${id}`,
      note: 'DigitalNZ aggregates New Zealand cultural content. Visit externalUrl for the source item.',
    };
  },
});
