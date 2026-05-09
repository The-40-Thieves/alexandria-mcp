import { fetchJSON } from '../utils/http.js';
import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

const API = 'https://api.digitalnz.org/v3';
const KEY_URL = 'https://digitalnz.org/developers';

function getKey(): string {
  const key = process.env.DIGITALNZ_API_KEY;
  if (!key) throw new Error(
    `DigitalNZ requires a free API key. Register at: ${KEY_URL} then set DIGITALNZ_API_KEY in your environment.`
  );
  return key;
}

interface DNZRecord {
  id: string;
  title?: string;
  creator?: string[];
  date?: string[];
  subject?: string[];
  language?: string[];
  landing_url?: string;
  type?: string[];
}

interface DNZResponse {
  search: { results: DNZRecord[] };
}

export async function digitalnzSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    query,
    api_key: getKey(),
    per_page: String(limit),
    'and[type][]': 'Text',
  });

  const data = await fetchJSON<DNZResponse>(`${API}/records.json?${params}`);

  return (data.search?.results ?? []).slice(0, limit).map(r => ({
    id: String(r.id),
    source: 'digitalnz' as const,
    title: r.title ?? String(r.id),
    authors: r.creator ?? [],
    year: r.date?.[0] ? parseInt(r.date[0], 10) : undefined,
    language: r.language?.[0],
    subjects: (r.subject ?? []).slice(0, 5),
    hasFullText: false,
    previewUrl: r.landing_url,
  }));
}

register('digitalnz', {
  description: 'DigitalNZ — New Zealand digital heritage including Māori and Pacific content. Requires free DIGITALNZ_API_KEY.',
  supportsIngest: false,
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
