import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

// BASE (Bielefeld Academic Search Engine)
// 400M+ records, 60% open access.
// Requires IP whitelisting — register at https://www.base-search.net/about/en/contact.php
// Once approved, set BASE_API_KEY env var (if token-based) or ensure your IP is whitelisted.

const SEARCH_URL = 'https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi';
const UA = 'Alexandria/9.0 (non-commercial research; ' + (process.env.CONTACT_EMAIL ?? 'alexandria-mcp@example.com') + ')';

type DCArr = string | string[] | undefined;

interface BASEDoc {
  dcidentifier?: DCArr;
  dctitle?: DCArr;
  dccreator?: DCArr;
  dcdate?: DCArr;
  dcdescription?: DCArr;
  dcsubject?: DCArr;
  dclanguage?: string;
  dclink?: string;
  dctype?: DCArr;
  dcoa?: string;   // '1' = open access
  dcpublisher?: DCArr;
  dcrights?: DCArr;
}

interface BASEResponse {
  response?: { numFound?: number; docs?: BASEDoc[] };
}

function toArr(v: DCArr): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

function first(v: DCArr): string {
  return toArr(v)[0] || '';
}

function buildUrl(params: Record<string, string | number>): string {
  const key = process.env.BASE_API_KEY;
  const base = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) base.set(k, String(v));
  // Pass key as userName param if set (some BASE API versions use this)
  if (key) base.set('userName', key);
  base.set('format', 'json');
  return `${SEARCH_URL}?${base.toString()}`;
}

const IP_ERROR = (
  'BASE API requires IP whitelisting.\n' +
  'Register at: https://www.base-search.net/about/en/contact.php\n' +
  'Select "Access BASE\'s HTTP API" and include your IP address.'
);

export async function baseSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const url = buildUrl({ func: 'PerformSearch', query, hits: limit, offset: 0 });
  let data: BASEResponse;
  try {
    data = await fetchJSON<BASEResponse>(url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    throw new Error(`BASE search failed: ${err instanceof Error ? err.message : String(err)}\n${IP_ERROR}`);
  }
  return (data.response?.docs || []).map(d => {
    const ids = toArr(d.dcidentifier);
    const id = d.dclink || ids[0] || '';
    const dateStr = first(d.dcdate);
    const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
    return {
      id,
      source: 'base' as const,
      title: first(d.dctitle) || 'Untitled',
      authors: toArr(d.dccreator),
      year: isNaN(year as number) ? undefined : year,
      language: d.dclanguage || undefined,
      subjects: toArr(d.dcsubject),
      hasFullText: d.dcoa === '1' || Boolean(d.dclink),
      previewUrl: d.dclink || undefined,
      description: first(d.dcdescription)?.substring(0, 300) || undefined,
    };
  });
}

export async function baseRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  // BASE has no direct record-by-ID REST endpoint — re-query by link/identifier
  const url = buildUrl({
    func: 'PerformSearch',
    query: `dc.identifier:"${id}"`,
    hits: 1,
    offset: 0,
  });
  let data: BASEResponse;
  try {
    data = await fetchJSON<BASEResponse>(url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    throw new Error(`BASE read failed: ${err instanceof Error ? err.message : String(err)}\n${IP_ERROR}`);
  }
  const d = data.response?.docs?.[0];
  if (!d) throw new Error(`BASE record not found: ${id}`);
  const dateStr = first(d.dcdate);
  const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
  return {
    text: first(d.dcdescription) || `No description available for BASE record ${id}`,
    title: first(d.dctitle) || id,
    authors: toArr(d.dccreator),
    year: isNaN(year as number) ? undefined : year,
    language: d.dclanguage || undefined,
  };
}

register('base', {
  description: 'BASE (Bielefeld Academic Search Engine) — 400M+ records from 11,000+ providers, 60% open access. Requires IP whitelisting (register at base-search.net). Set BASE_API_KEY if token-based.',
  supportsIngest: true,
  search: baseSearch,
  async read(id) {
    const raw = await baseRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
