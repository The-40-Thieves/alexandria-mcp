import { fetchJSON } from '../utils/http.js';
import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

// WDL content migrated to loc.gov in 2021.
// Accessible via the standard LOC API with the partof facet.
const LOC = 'https://www.loc.gov';

interface LOCResult {
  id: string;
  title?: string;
  contributor?: string[];
  date?: string;
  subject?: string[];
  language?: string[];
  online_format?: string[];
  url?: string;
  description?: string[];
  location_country?: string[];
}

interface LOCResponse {
  results: LOCResult[];
}

export async function wdlSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    fo: 'json',
    c: String(limit),
    fa: 'partof:world digital library',
  });

  const data = await fetchJSON<LOCResponse>(`${LOC}/search/?${params}`);

  return (data.results ?? []).slice(0, limit).map(r => ({
    id: r.id,
    source: 'wdl' as const,
    title: String(r.title ?? r.id),
    authors: r.contributor ?? [],
    year: r.date ? parseInt(r.date, 10) : undefined,
    language: r.language?.[0],
    subjects: (r.subject ?? []).slice(0, 5),
    hasFullText: (r.online_format ?? []).some(f => f.toLowerCase().includes('text')),
    previewUrl: r.url ?? `${LOC}/${r.id}`,
  }));
}

register('wdl', {
  description: 'World Digital Library (via LOC) — 19k+ rare and unique cultural heritage items from 200 countries, 8000 BCE–present. Maps, manuscripts, photographs, films, sound recordings.',
  supportsIngest: false,
  search: wdlSearch,
  async read(id) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: id.startsWith('http') ? id : `${LOC}/${id}`,
      note: 'WDL items are hosted at loc.gov. Visit externalUrl to access the digitized content.',
    };
  },
});
