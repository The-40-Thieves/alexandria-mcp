import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.si.edu/openaccess/api/v1.0';

function key(): string {
  const k = process.env.SMITHSONIAN_API_KEY;
  if (!k)
    throw new Error(
      'SMITHSONIAN_API_KEY is not set. Register free at https://api.data.gov/signup/',
    );
  return k;
}

interface SIRow {
  id: string;
  title?: string;
  unitCode?: string;
  content?: {
    indexedStructured?: {
      date?: string[];
      name?: string[];
      topic?: string[];
      object_type?: string[];
    };
    freetext?: {
      notes?: Array<{ label: string; content: string }>;
      physicalDescription?: Array<{ label: string; content: string }>;
    };
  };
  thumbnail?: string;
}

interface SIResponse {
  response: { rows?: SIRow[]; rowCount?: number };
}

interface SIRecord {
  response?: {
    row?: SIRow;
  };
}

export async function smithsonianSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<SIResponse>(
    `${BASE}/search?q=${encodeURIComponent(query)}&rows=${limit}&api_key=${key()}`,
  );
  return (data.response?.rows || []).map((r) => {
    const idx = r.content?.indexedStructured || {};
    const dates = idx.date || [];
    const year = dates.length > 0 ? parseInt(dates[0].substring(0, 4), 10) : undefined;
    return {
      id: r.id,
      source: 'smithsonian' as const,
      title: r.title || 'Untitled',
      authors: idx.name || [],
      year: Number.isNaN(year as number) ? undefined : year,
      subjects: [...(idx.topic || []), ...(idx.object_type || [])],
      hasFullText: Boolean(r.content?.freetext?.notes?.length),
      previewUrl: `https://collections.si.edu/search/results.htm?q=record_ID:${r.id}`,
    };
  });
}

export async function smithsonianRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<SIRecord>(`${BASE}/content/${id}?api_key=${key()}`);
  const r = data.response?.row;
  if (!r) throw new Error(`Smithsonian record not found: ${id}`);

  const notes = r.content?.freetext?.notes || [];
  const desc = r.content?.freetext?.physicalDescription || [];
  const text =
    [...notes, ...desc].map((n) => `${n.label}: ${n.content}`).join('\n') ||
    `No description available for Smithsonian record ${id}`;

  const idx = r.content?.indexedStructured || {};
  const dates = idx.date || [];
  const year = dates.length > 0 ? parseInt(dates[0].substring(0, 4), 10) : undefined;

  return {
    text,
    title: r.title || id,
    authors: idx.name || [],
    year: Number.isNaN(year as number) ? undefined : year,
    language: 'en',
  };
}

register('smithsonian', {
  description:
    'Smithsonian Institution — 14M+ records across all museums: American history, air & space, natural history, art, military artifacts. Requires SMITHSONIAN_API_KEY (free at api.data.gov).',
  supportsIngest: true,
  search: smithsonianSearch,
  async read(id) {
    const raw = await smithsonianRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
