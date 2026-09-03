import type { LibraryResult } from '../types.ts';
import { fetchWithRetry, redactUrl, retryAfterMs } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://zenodo.org/api';

function headers(): Record<string, string> {
  const key = process.env.ZENODO_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Honor a 429's Retry-After header rather than failing immediately or
// relying on the caller's fixed pacing interval alone. retryAfterMs caps
// the sleep so a large Retry-After cannot leak a timer well past the
// registry's own guard timeout; when it returns null, fail fast instead.
async function zenodoFetch<T>(url: string): Promise<T> {
  let res = await fetchWithRetry(url, { headers: headers() });
  if (res.status === 429) {
    const header = res.headers.get('retry-after');
    const waitMs = retryAfterMs(header);
    if (waitMs === null) {
      const suffix = /^\d+$/.test(header ?? '') ? 's' : '';
      throw new Error(`zenodo rate-limited; upstream asked to wait ${header}${suffix}`);
    }
    await sleep(waitMs);
    res = await fetchWithRetry(url, { headers: headers() });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}, url: ${redactUrl(url)}`);
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
  // Raises the Zenodo rate limit; the source works without one.
  optionalEnv: ['ZENODO_API_KEY'],
  pacing: { minIntervalMs: 2100 },
  search: zenodoSearch,
  async read(id) {
    const raw = await zenodoRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
