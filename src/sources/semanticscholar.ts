import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const GRAPH = 'https://api.semanticscholar.org/graph/v1';
const REC = 'https://api.semanticscholar.org/recommendations/v1';
const FIELDS = 'paperId,title,authors,year,abstract,openAccessPdf,externalIds,fieldsOfStudy';

function headers(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { 'x-api-key': key } : {};
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

function mapPaper(p: S2Paper): LibraryResult {
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
  const data = await fetchJSON<S2SearchResponse>(
    `${GRAPH}/paper/search?query=${encodeURIComponent(query)}&fields=${FIELDS}&limit=${limit}`,
    { headers: headers() },
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
  const p = await fetchJSON<S2Paper>(`${GRAPH}/paper/${id}?fields=${FIELDS}`, {
    headers: headers(),
  });
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
  const data = await fetchJSON<S2RecommendResponse>(
    `${REC}/papers/forpaper/${paperId}?fields=${FIELDS}&limit=${limit}`,
    { headers: headers() },
  );
  return (data.recommendedPapers || []).map(mapPaper);
}

register('semanticscholar', {
  description:
    'Semantic Scholar — 200M+ academic papers. Abstracts always available; OA PDF links for open access papers. Supports library_recommend.',
  supportsIngest: true,
  search: s2Search,
  async read(id) {
    const raw = await s2Read(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
