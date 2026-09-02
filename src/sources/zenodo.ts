import type { LibraryResult } from '../types.js';
import { fetchWithRetry } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://zenodo.org/api';

function headers(): Record<string, string> {
  const key = process.env.ZENODO_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Honor a 429's Retry-After header (seconds) rather than failing
// immediately or relying on the caller's fixed pacing interval alone.
async function zenodoFetch<T>(url: string): Promise<T> {
  let res = await fetchWithRetry(url, { headers: headers() });
  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get('retry-after'));
    await sleep((Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 2) * 1000);
    res = await fetchWithRetry(url, { headers: headers() });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

interface ZenodoRecord {
  id: number;
  doi?: string;
  metadata: {
    title: string;
    description?: string;
    creators?: Array<{ name: string }>;
    publication_date?: string;
    keywords?: string[];
    language?: string;
    resource_type?: { type: string };
  };
}

interface ZenodoSearchResponse {
  hits: { hits: ZenodoRecord[]; total: number };
}

function cleanHtml(s?: string): string {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeZenodo(data: ZenodoSearchResponse): LibraryResult[] {
  return (data.hits?.hits || []).map((r) => ({
    id: String(r.id),
    source: 'zenodo' as const,
    title: r.metadata.title,
    authors: (r.metadata.creators || []).map((c) => c.name),
    year: r.metadata.publication_date
      ? parseInt(r.metadata.publication_date.substring(0, 4), 10)
      : undefined,
    subjects: r.metadata.keywords || [],
    language: r.metadata.language,
    hasFullText: Boolean(r.metadata.description),
    previewUrl: r.doi ? `https://doi.org/${r.doi}` : `https://zenodo.org/record/${r.id}`,
    description: cleanHtml(r.metadata.description).substring(0, 300),
  }));
}

export async function zenodoSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await zenodoFetch<ZenodoSearchResponse>(
    `${BASE}/records?q=${encodeURIComponent(query)}&size=${limit}&sort=bestmatch`,
  );
  return normalizeZenodo(data);
}

export async function zenodoRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const r = await zenodoFetch<ZenodoRecord>(`${BASE}/records/${id}`);
  return {
    text: cleanHtml(r.metadata.description) || `No description available for Zenodo record ${id}`,
    title: r.metadata.title || id,
    authors: (r.metadata.creators || []).map((c) => c.name),
    year: r.metadata.publication_date
      ? parseInt(r.metadata.publication_date.substring(0, 4), 10)
      : undefined,
    language: r.metadata.language,
  };
}

register('zenodo', {
  description:
    'Zenodo — CERN open repository: papers, datasets, software. 2M+ records across all disciplines.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://zenodo.org',
  verifiedAt: '2026-09-01',
  pacing: { minIntervalMs: 2100 },
  search: zenodoSearch,
  async read(id) {
    const raw = await zenodoRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
