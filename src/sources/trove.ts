import { fetchJSON } from '../utils/http.js';
import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

const API = 'https://api.trove.nla.gov.au/v3';
const KEY_URL = 'https://trove.nla.gov.au/about/create-something/using-api';

function getKey(): string {
  const key = process.env.TROVE_API_KEY;
  if (!key) throw new Error(
    `Trove requires a free API key. Register at: ${KEY_URL} then set TROVE_API_KEY in your environment.`
  );
  return key;
}

interface TroveWork {
  id: string;
  title?: string;
  contributor?: string[];
  issued?: string;
  language?: string[];
  subject?: string[];
  troveUrl?: string;
}

interface TroveResponse {
  category: Array<{ records: { work: TroveWork[] } }>;
}

export async function troveSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    key: getKey(),
    category: 'book',
    n: String(limit),
    encoding: 'json',
    include: 'links',
  });

  const data = await fetchJSON<TroveResponse>(`${API}/result?${params}`);

  const works = data.category?.[0]?.records?.work ?? [];
  return works.slice(0, limit).map(w => ({
    id: w.id,
    source: 'trove' as const,
    title: w.title ?? w.id,
    authors: w.contributor ?? [],
    year: w.issued ? parseInt(w.issued, 10) : undefined,
    language: w.language?.[0],
    subjects: (w.subject ?? []).slice(0, 5),
    hasFullText: Boolean(w.troveUrl),
    previewUrl: w.troveUrl ?? `https://trove.nla.gov.au/work/${w.id}`,
  }));
}

register('trove', {
  description: 'Trove (NLA Australia) — 340M+ items from Australian libraries, newspapers, archives. Requires free TROVE_API_KEY.',
  supportsIngest: false,
  search: troveSearch,
  async read(id) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: `https://trove.nla.gov.au/work/${id}`,
      note: 'Trove provides digitized Australian content. Full text available for many items via externalUrl.',
    };
  },
});
