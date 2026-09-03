// The Guardian Open Platform: full-text search across Guardian journalism.
// Requires GUARDIAN_API_KEY.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://content.guardianapis.com';

interface GuardianResult {
  id: string;
  webTitle: string;
  webPublicationDate?: string;
  webUrl: string;
  fields?: { trailText?: string; bodyText?: string };
}

interface GuardianSearchResponse {
  response?: { results?: GuardianResult[] };
}

interface GuardianItemResponse {
  response?: { content?: GuardianResult };
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeGuardian(item: GuardianResult): LibraryResult {
  return {
    id: item.id,
    source: 'guardian',
    title: item.webTitle,
    authors: [],
    year: yearOf(item.webPublicationDate),
    hasFullText: true,
    description: item.fields?.trailText,
    published: item.webPublicationDate,
    url: item.webUrl,
  };
}

defineRest<GuardianSearchResponse>({
  name: 'guardian',
  description:
    'The Guardian Open Platform: full-text search across Guardian journalism, with article body text. Requires free GUARDIAN_API_KEY.',
  cluster: 'news_global',
  freshness: 'realtime',
  homepage: 'https://open-platform.theguardian.com',
  supportsIngest: true,
  // The Guardian Open Platform's terms require deleting cached/stored
  // content within 24 hours; gated behind ALEXANDRIA_INGEST_TIMEBOXED=1
  // (see src/sources/ingestPolicy.ts).
  ingestPolicy: 'timeboxed',
  auth: { type: 'query', env: 'GUARDIAN_API_KEY', param: 'api-key' },
  pacing: { dailyCap: 450 },
  search: {
    url: (q, limit) =>
      `${BASE}/search?q=${encodeURIComponent(q)}&page-size=${limit}&show-fields=trailText,bodyText`,
    pick: (raw) => raw.response?.results ?? [],
    normalize: normalizeGuardian,
  },
  read: {
    url: (id) => `${BASE}/${id}?show-fields=bodyText`,
    normalize: (raw: GuardianItemResponse, id: string) => {
      const item = raw.response?.content;
      const text = item?.fields?.bodyText || `No body text available for ${id}.`;
      return {
        title: item?.webTitle || id,
        authors: [],
        year: yearOf(item?.webPublicationDate),
        ...truncateText(text),
      };
    },
  },
});
