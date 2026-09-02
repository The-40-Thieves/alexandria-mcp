import type { LibraryResult } from '../types.ts';
import { fetchWithRetry, retryAfterMs } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const GRAPH = 'https://api.semanticscholar.org/graph/v1';
const REC = 'https://api.semanticscholar.org/recommendations/v1';
const FIELDS = 'paperId,title,authors,year,abstract,openAccessPdf,externalIds,fieldsOfStudy';

function headers(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { 'x-api-key': key } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Semantic Scholar's shared unauthenticated pool 429s aggressively; on a
// 429 read Retry-After and sleep once before retrying, rather than failing
// immediately or retrying indefinitely. retryAfterMs caps the sleep so a
// large Retry-After (e.g. a day) cannot leak a timer well past the
// registry's own guard timeout; when it returns null, fail fast instead.
async function s2Fetch<T>(url: string): Promise<T> {
  let res = await fetchWithRetry(url, { headers: headers() });
  if (res.status === 429) {
    const header = res.headers.get('retry-after');
    const waitMs = retryAfterMs(header);
    if (waitMs === null) {
      const suffix = /^\d+$/.test(header ?? '') ? 's' : '';
      throw new Error(`semanticscholar rate-limited; upstream asked to wait ${header}${suffix}`);
    }
    await sleep(waitMs);
    res = await fetchWithRetry(url, { headers: headers() });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}, url: ${url}`);
  return res.json() as Promise<T>;
}

interface S2Paper {
  paperId: string;
  title?: string;
  authors?: Array<{ name: string }>;
  year?: number;
  abstract?: string;
  openAccessPdf?: { url: string; status: string };
  externalIds?: { ArXiv?: string; DOI?: string; PubMed?: string };
  fieldsOfStudy?: string[];
}

interface S2SearchResponse {
  data: S2Paper[];
  total?: number;
}

interface S2RecommendResponse {
  recommendedPapers: S2Paper[];
}

export function mapPaper(p: S2Paper): LibraryResult {
  return {
    id: p.paperId,
    source: 'semanticscholar' as const,
    title: p.title || 'Untitled',
    authors: (p.authors || []).map((a) => a.name),
    year: p.year,
    subjects: p.fieldsOfStudy || [],
    hasFullText: Boolean(p.openAccessPdf?.url || p.abstract),
    previewUrl:
      p.openAccessPdf?.url ||
      (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : undefined),
    description: p.abstract?.substring(0, 300),
  };
}

export async function s2Search(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await s2Fetch<S2SearchResponse>(
    `${GRAPH}/paper/search?query=${encodeURIComponent(query)}&fields=${FIELDS}&limit=${limit}`,
  );
  return (data.data || []).map(mapPaper);
}

export async function s2Read(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const p = await s2Fetch<S2Paper>(`${GRAPH}/paper/${id}?fields=${FIELDS}`);
  const text = p.abstract || '';
  if (!text)
    throw new Error(
      `Semantic Scholar paper ${id} has no abstract. OA PDF: ${p.openAccessPdf?.url || 'none'}`,
    );
  return {
    text,
    title: p.title || id,
    authors: (p.authors || []).map((a) => a.name),
    year: p.year,
    language: 'en',
  };
}

export async function s2Recommend(paperId: string, limit = 20): Promise<LibraryResult[]> {
  const data = await s2Fetch<S2RecommendResponse>(
    `${REC}/papers/forpaper/${paperId}?fields=${FIELDS}&limit=${limit}`,
  );
  return (data.recommendedPapers || []).map(mapPaper);
}

register('semanticscholar', {
  description:
    'Semantic Scholar: 200M+ academic papers. Abstracts always available; OA PDF links for open access papers. Supports library_recommend. Set SEMANTIC_SCHOLAR_API_KEY for a dedicated rate pool.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://www.semanticscholar.org',
  verifiedAt: '2026-09-01',
  // Raises the shared anonymous rate limit; the source works without one.
  optionalEnv: ['SEMANTIC_SCHOLAR_API_KEY'],
  pacing: { minIntervalMs: 1100 },
  search: s2Search,
  async read(id) {
    const raw = await s2Read(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
