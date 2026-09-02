// Hugging Face Papers: community-curated arXiv paper feed with upvotes and
// discussion. No API key required. A custom register() rather than
// defineRest(): read() delegates to the existing arxiv adapter, since every
// hfpapers id is an arXiv id and arxiv.ts already fetches the HTML full
// text for it.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { getAdapter, register } from './registry.js';

const BASE = 'https://huggingface.co/api/papers';

interface HfPaper {
  id: string;
  title?: string;
  authors?: Array<{ name?: string }>;
  publishedAt?: string;
}

interface HfPapersSearchItem {
  paper: HfPaper;
}

type HfPapersSearchResponse = HfPapersSearchItem[];

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeHfPapers(item: HfPapersSearchItem): LibraryResult | null {
  const paper = item.paper;
  if (!paper?.id) return null;
  return {
    id: paper.id,
    source: 'hfpapers',
    title: paper.title || paper.id,
    authors: (paper.authors ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
    year: yearOf(paper.publishedAt),
    hasFullText: true,
    published: paper.publishedAt,
    url: `https://huggingface.co/papers/${paper.id}`,
  };
}

export async function hfpapersSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<HfPapersSearchResponse>(
    `${BASE}/search?q=${encodeURIComponent(query)}`,
  );
  const results: LibraryResult[] = [];
  for (const item of data ?? []) {
    const normalized = normalizeHfPapers(item);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

export async function hfpapersRead(id: string): Promise<ReadResult> {
  return getAdapter('arxiv').read(id);
}

register('hfpapers', {
  description:
    'Hugging Face Papers: a community-curated feed of arXiv papers with upvotes and discussion threads. No API key required. Full text is read via the arxiv source (every id is an arXiv id).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'ai_research',
  freshness: 'daily',
  homepage: 'https://huggingface.co/papers',
  verifiedAt: '2026-09-01',
  pacing: { minIntervalMs: 700 },
  search: hfpapersSearch,
  read: hfpapersRead,
});
