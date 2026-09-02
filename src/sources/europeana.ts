import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const API = 'https://api.europeana.eu/record/v2/search.json';
const KEY_URL = 'https://pro.europeana.eu/page/developer-keys';

function getKey(): string {
  const key = process.env.EUROPEANA_API_KEY;
  if (!key)
    throw new Error(
      `Europeana requires EUROPEANA_API_KEY. Register a free key at: ${KEY_URL} then set EUROPEANA_API_KEY in your environment.`,
    );
  return key;
}

interface EuropeanaItem {
  id: string;
  title?: string[];
  dcCreator?: string[];
  year?: string[];
  dcLanguage?: string[];
  dcSubject?: string[];
  guid?: string;
  edmIsShownBy?: string;
}

interface EuropeanaResponse {
  items?: EuropeanaItem[];
}

export function normalizeEuropeana(data: EuropeanaResponse, limit: number): LibraryResult[] {
  return (data.items ?? []).slice(0, limit).map((item) => ({
    id: item.id,
    source: 'europeana' as const,
    title: item.title?.[0] ?? item.id,
    authors: item.dcCreator ?? [],
    year: item.year?.[0] ? parseInt(item.year[0], 10) : undefined,
    language: item.dcLanguage?.[0],
    subjects: (item.dcSubject ?? []).slice(0, 5),
    hasFullText: Boolean(item.edmIsShownBy),
    previewUrl: item.guid ?? `https://www.europeana.eu/item${item.id}`,
  }));
}

export async function europeanaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const key = getKey();
  const params = new URLSearchParams({
    query,
    wskey: key,
    rows: String(limit),
    qf: 'TYPE:TEXT',
  });
  const data = await fetchJSON<EuropeanaResponse>(`${API}?${params}`, {
    headers: { 'X-Api-Key': key },
  });
  return normalizeEuropeana(data, limit);
}

register('europeana', {
  description:
    'Europeana — 50M+ cultural heritage items from European museums, libraries, and archives. Requires free EUROPEANA_API_KEY.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'culture',
  freshness: 'daily',
  homepage: 'https://www.europeana.eu',
  verifiedAt: '2026-09-01',
  auth: { type: 'query', env: 'EUROPEANA_API_KEY', param: 'wskey' },
  search: europeanaSearch,
  async read(id) {
    const previewUrl = `https://www.europeana.eu/item${id}`;
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: previewUrl,
      note: 'Europeana aggregates metadata from European cultural institutions. Visit externalUrl for the source item.',
    };
  },
});
