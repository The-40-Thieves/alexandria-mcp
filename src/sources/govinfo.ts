import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { stripHtml } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.govinfo.gov';

function key(): string {
  const k = process.env.GOVINFO_API_KEY;
  if (!k)
    throw new Error(
      'GovInfo requires GOVINFO_API_KEY. Register a free key at: https://api.govinfo.gov/docs/ ' +
        'then set GOVINFO_API_KEY in your environment.',
    );
  return k;
}

interface GovInfoSearchResult {
  title?: string;
  packageId: string;
  granuleId?: string;
  dateIssued?: string;
  collectionCode?: string;
  governmentAuthor?: string[];
  download?: { txtLink?: string; pdfLink?: string };
  resultLink?: string;
}

interface GovInfoSearchResponse {
  count?: number;
  offsetMark?: string;
  results?: GovInfoSearchResult[];
}

export function normalizeGovInfo(data: GovInfoSearchResponse, limit: number): LibraryResult[] {
  return (data.results ?? []).slice(0, limit).map((r) => ({
    id: r.granuleId ?? r.packageId,
    source: 'govinfo' as const,
    title: r.title || r.packageId,
    authors: r.governmentAuthor ?? [],
    year: r.dateIssued ? parseInt(r.dateIssued.substring(0, 4), 10) : undefined,
    subjects: r.collectionCode ? [r.collectionCode] : [],
    hasFullText: Boolean(r.download?.txtLink),
    previewUrl:
      r.resultLink ?? `https://www.govinfo.gov/content/pkg/${r.packageId}/html/${r.packageId}.htm`,
  }));
}

export async function govinfoSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<GovInfoSearchResponse>(`${BASE}/search?api_key=${key()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      pageSize: limit,
      offsetMark: '*',
      resultLevel: 'default',
    }),
  });
  return normalizeGovInfo(data, limit);
}

export async function govinfoRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  // Get package summary for metadata
  const summary = await fetchJSON<{ title?: string; dateIssued?: string; collectionName?: string }>(
    `${BASE}/packages/${id}/summary?api_key=${key()}`,
  );

  // Get HTML content
  const html = await fetchText(`${BASE}/packages/${id}/htm?api_key=${key()}`);
  const text = stripHtml(html);

  if (text.length < 100) {
    throw new Error(
      `GovInfo package ${id} returned no readable text. It may not have an HTML version.`,
    );
  }

  return {
    text,
    title: summary.title || id,
    authors: [],
    year: summary.dateIssued ? parseInt(summary.dateIssued.substring(0, 4), 10) : undefined,
    language: 'en',
  };
}

register('govinfo', {
  description:
    'GovInfo: US Congressional Record, Federal Register, US Code, Bills, CFR, and more. GPO official archive. Requires free GOVINFO_API_KEY.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://www.govinfo.gov',
  verifiedAt: '2026-09-01',
  auth: { type: 'query', env: 'GOVINFO_API_KEY', param: 'api_key' },
  search: govinfoSearch,
  async read(id) {
    const raw = await govinfoRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
