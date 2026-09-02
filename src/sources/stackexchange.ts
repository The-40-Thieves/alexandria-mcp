// Stack Exchange (stackoverflow.com site). Works keyless at the shared
// rate limit; STACKEXCHANGE_KEY, if set, is appended as the key query
// param for a dedicated pool.
import type { LibraryResult } from '../types.js';
import { stripHtml } from '../utils/text-clean.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.stackexchange.com/2.3';

interface SeQuestion {
  question_id: number;
  title: string;
  creation_date: number;
  link: string;
  body?: string;
}

interface SeSearchResponse {
  items: SeQuestion[];
}

interface SeAnswer {
  body?: string;
  score: number;
}

interface SeAnswersResponse {
  items: SeAnswer[];
}

export function normalizeStackExchange(q: SeQuestion): LibraryResult {
  const description = q.body ? stripHtml(q.body).slice(0, 300) : undefined;
  return {
    id: String(q.question_id),
    source: 'stackexchange',
    title: q.title,
    authors: [],
    year: new Date(q.creation_date * 1000).getFullYear(),
    hasFullText: Boolean(description),
    description,
    published: new Date(q.creation_date * 1000).toISOString(),
    previewUrl: q.link,
  };
}

function searchUrl(q: string, limit: number): string {
  const key = process.env.STACKEXCHANGE_KEY;
  const params = new URLSearchParams({
    site: 'stackoverflow',
    q,
    pagesize: String(limit),
    order: 'desc',
    sort: 'relevance',
    filter: 'withbody',
  });
  if (key) params.set('key', key);
  return `${BASE}/search/advanced?${params.toString()}`;
}

defineRest<SeSearchResponse>({
  name: 'stackexchange',
  description:
    'Stack Overflow (via the Stack Exchange API): advanced full-text question search. Works keyless at the shared rate limit; set STACKEXCHANGE_KEY for a dedicated pool.',
  cluster: 'developer',
  freshness: 'realtime',
  homepage: 'https://stackoverflow.com',
  supportsIngest: true,
  verifiedAt: '2026-09-01',
  search: {
    url: searchUrl,
    pick: (raw) => raw.items ?? [],
    normalize: normalizeStackExchange,
  },
  read: {
    url: (id) => {
      const key = process.env.STACKEXCHANGE_KEY;
      const params = new URLSearchParams({
        site: 'stackoverflow',
        filter: 'withbody',
        sort: 'votes',
      });
      if (key) params.set('key', key);
      return `${BASE}/questions/${encodeURIComponent(id)}/answers?${params.toString()}`;
    },
    normalize: (raw: SeAnswersResponse, id: string) => {
      const answers = raw.items ?? [];
      const text = answers.length
        ? answers
            .map((a, i) => `Answer ${i + 1} (score ${a.score}):\n${stripHtml(a.body ?? '')}`)
            .join('\n\n')
        : `No answers found for question ${id}.`;
      return { title: `Question ${id}`, authors: [], ...truncateText(text) };
    },
  },
});
