// Papers with Code: ML papers cross-referenced with their code
// implementations. The original paperswithcode.com API was retired
// 2025-07-24; this queries paperswithcode.co, a community-run mirror of
// the same dataset. No API key required.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://paperswithcode.co/api/v1/papers';

interface PwcPaper {
  id: string;
  title: string;
  authors?: string[];
  published?: string;
  url_abs?: string;
  abstract?: string;
}

interface PwcSearchResponse {
  results?: PwcPaper[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizePapersWithCode(item: PwcPaper): LibraryResult {
  return {
    id: item.id,
    source: 'paperswithcode',
    title: item.title,
    authors: item.authors ?? [],
    year: yearOf(item.published),
    hasFullText: true,
    published: item.published,
    url: item.url_abs,
  };
}

defineRest<PwcSearchResponse>({
  name: 'paperswithcode',
  description:
    'Papers with Code: machine learning papers cross-referenced with their code implementations. ' +
    'Queries the community mirror at paperswithcode.co (the original paperswithcode.com API was ' +
    'retired 2025-07-24). No API key required.',
  cluster: 'ai_research',
  freshness: 'daily',
  homepage: 'https://paperswithcode.co',
  supportsIngest: false,
  verifiedAt: '2026-09-03',
  search: {
    url: (q, limit) => `${BASE}/?q=${encodeURIComponent(q)}&items_per_page=${limit}`,
    pick: (raw) => raw.results ?? [],
    normalize: normalizePapersWithCode,
  },
  read: {
    url: (id) => `${BASE}/${encodeURIComponent(id)}/`,
    normalize: (raw: PwcPaper, id: string) => ({
      title: raw.title || id,
      authors: raw.authors ?? [],
      year: yearOf(raw.published),
      ...truncateText(raw.abstract || `No abstract available for ${id}.`),
    }),
  },
});
