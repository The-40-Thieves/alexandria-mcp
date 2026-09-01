import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

// DPLA allows 500 req/day without a key. For more: register free at dp.la
const DPLA = 'https://api.dp.la/v2';

interface DPLADoc {
  id: string;
  sourceResource?: {
    title?: string[];
    creator?: string[];
    date?: Array<{ begin?: string }>;
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

function buildUrl(endpoint: string): string {
  const key = process.env.DPLA_API_KEY;
  return key ? `${DPLA}${endpoint}&api_key=${key}` : `${DPLA}${endpoint}`;
}

export async function dplaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const url = buildUrl(
    `/items?q=${encodeURIComponent(query)}&page_size=${limit}&fields=id,sourceResource,isShownAt`,
  );
  const data = await fetchJSON<DPLAResponse>(url);

  return (data.docs ?? []).slice(0, limit).map((doc) => {
    const sr = doc.sourceResource ?? {};
    return {
      id: doc.id,
      source: 'dpla' as const,
      title: sr.title?.[0] ?? doc.id,
      authors: sr.creator ?? [],
      year: sr.date?.[0]?.begin ? parseInt(sr.date[0].begin, 10) : undefined,
      language: sr.language?.[0]?.name,
      subjects: (sr.subject ?? []).slice(0, 5).map((s) => s.name),
      hasFullText: false,
      previewUrl: doc.isShownAt,
    };
  });
}

register('dpla', {
  description:
    'Digital Public Library of America — 17M+ items from US libraries, archives, and museums. Metadata aggregator. Set DPLA_API_KEY for >500 req/day.',
  supportsIngest: false,
  search: dplaSearch,
  async read(id) {
    const url = buildUrl(`/items/${id}`);
    const data = await fetchJSON<DPLAResponse>(url);
    const doc = data.docs?.[0];
    const sr = doc?.sourceResource ?? {};
    return {
      title: sr.title?.[0] ?? id,
      authors: sr.creator ?? [],
      year: sr.date?.[0]?.begin ? parseInt(sr.date[0].begin, 10) : undefined,
      metadataOnly: true,
      externalUrl: doc?.isShownAt,
      note: 'DPLA aggregates metadata from partner institutions. Visit externalUrl for the source item.',
    };
  },
});
