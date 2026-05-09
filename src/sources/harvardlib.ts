import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE_URL = 'https://api.lib.harvard.edu/v2';

type DCVal = string | string[] | undefined;

interface DCItem {
  'dc:identifier'?: DCVal;
  'dc:title'?: DCVal;
  'dc:creator'?: DCVal;
  'dc:date'?: DCVal;
  'dc:description'?: DCVal;
  'dc:subject'?: DCVal;
  'dc:language'?: DCVal;
  'dc:type'?: DCVal;
  'dc:relation'?: DCVal;
}

interface HarvardResponse {
  pagination?: { numFound?: number; start?: number; rows?: number };
  items?: DCItem[];
}

function toArr(v: DCVal): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

function first(v: DCVal): string {
  return toArr(v)[0] || '';
}

// Extract best ID from dc:identifier array
function extractId(ids: string[]): string {
  // Prefer long HOLLIS numeric ID (~18 digits)
  const hollis = ids.find(i => /^\d{15,}$/.test(i));
  if (hollis) return hollis;
  // Extract from alma URL: /alma/{id}/catalog
  for (const i of ids) {
    const m = i.match(/\/alma\/(\d+)/);
    if (m) return m[1];
  }
  // Fall back to encoded first id
  return encodeURIComponent(ids[0] || '');
}

export async function harvardlibSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<HarvardResponse>(
    `${BASE_URL}/items.dc.json?q=${encodeURIComponent(query)}&limit=${limit}&start=1`
  );
  return (data.items || []).map(item => {
    const ids = toArr(item['dc:identifier']);
    const id = extractId(ids);
    const dateStr = first(item['dc:date']);
    const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
    const url = ids.find(i => i.startsWith('http'));
    return {
      id,
      source: 'harvardlib' as const,
      title: first(item['dc:title']) || 'Untitled',
      authors: toArr(item['dc:creator']),
      year: isNaN(year as number) ? undefined : year,
      language: first(item['dc:language']) || undefined,
      subjects: toArr(item['dc:subject']),
      hasFullText: Boolean(first(item['dc:description'])),
      previewUrl: url,
      description: first(item['dc:description'])?.substring(0, 300) || undefined,
    };
  });
}

export async function harvardlibRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  // Single item — may return item directly or wrapped
  const data = await fetchJSON<HarvardResponse | DCItem>(
    `${BASE_URL}/items/${id}.dc.json`
  );
  const wrapped = data as HarvardResponse;
  const item: DCItem = wrapped.items?.[0] ?? (data as DCItem);
  const dateStr = first(item['dc:date']);
  const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
  return {
    text: first(item['dc:description']) || `No description available for Harvard Library item ${id}`,
    title: first(item['dc:title']) || id,
    authors: toArr(item['dc:creator']),
    year: isNaN(year as number) ? undefined : year,
    language: first(item['dc:language']) || undefined,
  };
}

register('harvardlib', {
  description: 'Harvard LibraryCloud — 20M+ records from Harvard Libraries: books, archives, manuscripts, maps, photographs, theses. Public REST API, no key required.',
  supportsIngest: true,
  search: harvardlibSearch,
  async read(id) {
    const raw = await harvardlibRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
