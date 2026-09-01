import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.osti.gov/api/v1/records';

interface OSTIRecord {
  osti_id: string;
  title: string;
  authors?: Array<{ first_name?: string; last_name?: string }>;
  publication_date?: string;
  description?: string;
  subject_areas?: string;
  language?: string;
  doi?: string;
}

export async function ostiSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const records = await fetchJSON<OSTIRecord[]>(
    `${BASE}?q=${encodeURIComponent(query)}&rows=${limit}&sort=score+desc`,
  );
  return (records || []).map((r) => ({
    id: r.osti_id,
    source: 'osti' as const,
    title: r.title,
    authors: (r.authors || [])
      .map((a) => `${a.first_name || ''} ${a.last_name || ''}`.trim())
      .filter(Boolean),
    year: r.publication_date ? parseInt(r.publication_date.substring(0, 4), 10) : undefined,
    subjects: r.subject_areas
      ? r.subject_areas
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    language: r.language,
    hasFullText: Boolean(r.description),
    previewUrl: r.doi ? `https://doi.org/${r.doi}` : `https://www.osti.gov/biblio/${r.osti_id}`,
    description: r.description?.substring(0, 300),
  }));
}

export async function ostiRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const records = await fetchJSON<OSTIRecord[]>(`${BASE}/${id}`);
  const r = Array.isArray(records) ? records[0] : (records as unknown as OSTIRecord);
  if (!r) throw new Error(`OSTI record ${id} not found`);
  return {
    text: r.description || `No abstract available for OSTI:${id}`,
    title: r.title || id,
    authors: (r.authors || [])
      .map((a) => `${a.first_name || ''} ${a.last_name || ''}`.trim())
      .filter(Boolean),
    year: r.publication_date ? parseInt(r.publication_date.substring(0, 4), 10) : undefined,
    language: r.language,
  };
}

register('osti', {
  description:
    'DOE OSTI — Department of Energy research: nuclear, energy, physics, materials science. No API key required.',
  supportsIngest: true,
  search: ostiSearch,
  async read(id) {
    const raw = await ostiRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
