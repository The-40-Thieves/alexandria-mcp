import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

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
}

interface LOCResponse {
  results: LOCResult[];
}

export function normalizeLoc(data: LOCResponse, limit: number): LibraryResult[] {
  return (data.results ?? []).slice(0, limit).map((r) => ({
    id: r.id,
    source: 'loc' as const,
    title: String(r.title ?? r.id),
    authors: r.contributor ?? [],
    year: r.date ? parseInt(r.date, 10) : undefined,
    language: r.language?.[0],
    subjects: (r.subject ?? []).slice(0, 5),
    hasFullText: (r.online_format ?? []).some((f) => f.toLowerCase().includes('text')),
    previewUrl: r.url ?? `${LOC}/${r.id}`,
  }));
}

export async function locSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    fo: 'json',
    c: String(limit),
    fa: 'online-format:online text',
  });
  const data = await fetchJSON<LOCResponse>(`${LOC}/search/?${params}`);
  return normalizeLoc(data, limit);
}

register('loc', {
  description:
    'Library of Congress — US history, maps, newspapers, manuscripts. 170M+ items. Metadata and discovery.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'archives',
  freshness: 'daily',
  homepage: 'https://www.loc.gov',
  pacing: { minIntervalMs: 3100 }, // loc.gov's stated limit is ~20 req/min
  search: locSearch,
  async read(id) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: id.startsWith('http') ? id : `${LOC}/${id}`,
      note: 'LOC is a discovery source. Visit externalUrl for full content access.',
    };
  },
});
