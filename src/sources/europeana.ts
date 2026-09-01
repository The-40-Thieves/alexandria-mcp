import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const API = 'https://api.europeana.eu/v2/record/search.json';
const KEY_URL = 'https://pro.europeana.eu/page/developer-keys';

function getKey(): string {
  const key = process.env.EUROPEANA_API_KEY;
  if (!key)
    throw new Error(
      `Europeana requires a free API key. Register at: ${KEY_URL} then set EUROPEANA_API_KEY in your environment.`,
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
  edmIsShownAt?: string[];
  type?: string;
}

interface EuropeanaResponse {
  items: EuropeanaItem[];
}

export async function europeanaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    query,
    wskey: getKey(),
    rows: String(limit),
    qf: 'TYPE:TEXT',
    profile: 'minimal',
  });

  const data = await fetchJSON<EuropeanaResponse>(`${API}?${params}`);

  return (data.items ?? []).slice(0, limit).map((item) => ({
    id: item.id,
    source: 'europeana' as const,
    title: item.title?.[0] ?? item.id,
    authors: item.dcCreator ?? [],
    year: item.year?.[0] ? parseInt(item.year[0], 10) : undefined,
    language: item.dcLanguage?.[0],
    subjects: (item.dcSubject ?? []).slice(0, 5),
    hasFullText: false,
    previewUrl: item.edmIsShownAt?.[0] ?? `https://www.europeana.eu/item${item.id}`,
  }));
}

register('europeana', {
  description:
    'Europeana — 50M+ cultural heritage items from European museums, libraries, and archives. Requires free EUROPEANA_API_KEY.',
  supportsIngest: false,
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
