import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://catalog.archives.gov/api/v2';

interface NARARecord {
  naId?: number | string;
  title?: string;
  description?: {
    item?: { scopeAndContentNote?: string; generalNote?: string; dateRange?: { inclusiveDates?: string } };
    series?: { scopeAndContentNote?: string; title?: string };
    fileUnit?: { scopeAndContentNote?: string };
    recordGroup?: { title?: string };
  };
  levelOfDescription?: string;
  publicContributions?: { transcriptions?: Array<{ text: string }> };
}

interface NARAResponse {
  opaResponse?: {
    results?: {
      result?: NARARecord[];
      '@total'?: string;
    };
  };
}

interface NARASingleResponse {
  opaResponse?: { result?: NARARecord };
}

function getNote(rec: NARARecord): string {
  return rec.description?.item?.scopeAndContentNote ||
    rec.description?.series?.scopeAndContentNote ||
    rec.description?.fileUnit?.scopeAndContentNote ||
    rec.description?.item?.generalNote || '';
}

function getTitle(rec: NARARecord): string {
  return rec.title || rec.description?.series?.title || rec.description?.recordGroup?.title || String(rec.naId || '');
}

export async function naraSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<NARAResponse>(
    `${BASE}/records?q=${encodeURIComponent(query)}&limit=${limit}&offset=0`
  );
  return (data.opaResponse?.results?.result || []).map(r => {
    const dateStr = r.description?.item?.dateRange?.inclusiveDates || '';
    const yearMatch = dateStr.match(/(\d{4})/);
    return {
      id: String(r.naId || ''),
      source: 'nara' as const,
      title: getTitle(r),
      authors: [],
      year: yearMatch ? parseInt(yearMatch[1], 10) : undefined,
      subjects: r.levelOfDescription ? [r.levelOfDescription] : [],
      hasFullText: Boolean(getNote(r)),
      previewUrl: r.naId ? `https://catalog.archives.gov/id/${r.naId}` : undefined,
      description: getNote(r).substring(0, 300) || undefined,
    };
  });
}

export async function naraRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const data = await fetchJSON<NARASingleResponse>(`${BASE}/records/${id}`);
  const r = data.opaResponse?.result;
  if (!r) throw new Error(`NARA record not found: ${id}`);

  // Also include any crowd-sourced transcriptions
  const transcriptions = r.publicContributions?.transcriptions?.map(t => t.text).join('\n') || '';
  const note = getNote(r);
  const text = [note, transcriptions].filter(Boolean).join('\n\n') ||
    `No description available for NARA record ${id}`;

  return {
    text,
    title: getTitle(r),
    authors: [],
    language: 'en',
  };
}

register('nara', {
  description: 'US National Archives (NARA) — 32M+ descriptions of historical government records: war diaries, presidential papers, military records, federal agencies. No API key required.',
  supportsIngest: true,
  search: naraSearch,
  async read(id) {
    const raw = await naraRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
