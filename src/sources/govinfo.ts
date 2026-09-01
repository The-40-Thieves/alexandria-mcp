import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.govinfo.gov';

function key(): string {
  const k = process.env.GOVINFO_API_KEY;
  if (!k) throw new Error('GOVINFO_API_KEY is not set');
  return k;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface GovInfoPackage {
  packageId: string;
  title?: string;
  dateIssued?: string;
  collectionCode?: string;
  collectionName?: string;
  packageLink?: string;
  lastModified?: string;
}

interface GovInfoSearchResponse {
  count?: number;
  packages?: GovInfoPackage[];
  results?: GovInfoPackage[];
}

export async function govinfoSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<GovInfoSearchResponse>(
    `${BASE}/search?query=${encodeURIComponent(query)}&pageSize=${limit}&api_key=${key()}`,
  );
  const items = data.packages || data.results || [];
  return items.map((p) => ({
    id: p.packageId,
    source: 'govinfo' as const,
    title: p.title || p.packageId,
    authors: [],
    year: p.dateIssued ? parseInt(p.dateIssued.substring(0, 4), 10) : undefined,
    subjects: p.collectionCode ? [p.collectionCode] : [],
    hasFullText: true,
    previewUrl: `https://www.govinfo.gov/content/pkg/${p.packageId}/html/${p.packageId}.htm`,
    description: p.collectionName,
  }));
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
    'GovInfo — US Congressional Record, Federal Register, US Code, Bills, CFR, and more. GPO official archive.',
  supportsIngest: true,
  search: govinfoSearch,
  async read(id) {
    const raw = await govinfoRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
