import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.nsf.gov/services/v1/awards.json';
const PRINT_FIELDS = 'id,title,piFirstName,piLastName,date,abstractText,keywords';

interface NSFAward {
  id: string;
  title: string;
  piFirstName?: string;
  piLastName?: string;
  date?: string; // MM/DD/YYYY
  abstractText?: string;
  keywords?: string;
}

interface NSFResponse {
  response: { award: NSFAward[] };
}

function parseNSFYear(date?: string): number | undefined {
  if (!date) return undefined;
  // Formats: MM/DD/YYYY or YYYY-MM-DD
  const m = date.match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

export async function nsfSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<NSFResponse>(
    `${BASE}?keyword=${encodeURIComponent(query)}&rpp=${limit}&offset=0&printFields=${PRINT_FIELDS}`,
  );
  return (data.response?.award || []).map((a) => ({
    id: a.id,
    source: 'nsf' as const,
    title: a.title,
    authors: a.piFirstName ? [`${a.piFirstName} ${a.piLastName || ''}`.trim()] : [],
    year: parseNSFYear(a.date),
    subjects: a.keywords
      ? a.keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    hasFullText: Boolean(a.abstractText),
    previewUrl: `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${a.id}`,
    description: a.abstractText?.substring(0, 300),
  }));
}

export async function nsfRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<NSFResponse>(`${BASE}?id=${id}&printFields=${PRINT_FIELDS}`);
  const a = data.response?.award?.[0];
  if (!a) throw new Error(`NSF award ${id} not found`);
  return {
    text: a.abstractText || `No abstract available for NSF award ${id}`,
    title: a.title || id,
    authors: a.piFirstName ? [`${a.piFirstName} ${a.piLastName || ''}`.trim()] : [],
    year: parseNSFYear(a.date),
    language: 'en',
  };
}

register('nsf', {
  description:
    'NSF Awards — National Science Foundation research grants and abstracts across all scientific disciplines.',
  supportsIngest: true,
  search: nsfSearch,
  async read(id) {
    const raw = await nsfRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
