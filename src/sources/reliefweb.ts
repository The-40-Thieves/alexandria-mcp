// ReliefWeb: humanitarian reports and situation updates, run by UN OCHA.
// Requires a registered RELIEFWEB_APPNAME.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.reliefweb.int/v2';

interface ReliefwebFields {
  title?: string;
  url?: string;
  body?: string;
  date?: { created?: string };
}

interface ReliefwebReport {
  id: string;
  fields?: ReliefwebFields;
}

interface ReliefwebSearchResponse {
  data?: ReliefwebReport[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeReliefweb(item: ReliefwebReport): LibraryResult {
  return {
    id: item.id,
    source: 'reliefweb',
    title: item.fields?.title || item.id,
    authors: [],
    year: yearOf(item.fields?.date?.created),
    hasFullText: Boolean(item.fields?.body),
    published: item.fields?.date?.created,
    url: item.fields?.url,
  };
}

defineRest<ReliefwebSearchResponse>({
  name: 'reliefweb',
  description:
    'ReliefWeb: humanitarian reports and situation updates from UN OCHA and partner organizations. Requires a registered RELIEFWEB_APPNAME.',
  cluster: 'geopolitical',
  freshness: 'daily',
  homepage: 'https://reliefweb.int',
  supportsIngest: true,
  auth: { type: 'query', env: 'RELIEFWEB_APPNAME', param: 'appname' },
  search: {
    url: (q, limit) =>
      `${BASE}/reports?query[value]=${encodeURIComponent(q)}&limit=${limit}&fields[include][]=title&fields[include][]=date.created&fields[include][]=url&fields[include][]=body`,
    pick: (raw) => raw.data ?? [],
    normalize: normalizeReliefweb,
  },
  read: {
    url: (id) =>
      `${BASE}/reports/${encodeURIComponent(id)}?fields[include][]=title&fields[include][]=date.created&fields[include][]=body`,
    normalize: (raw: { data?: ReliefwebReport[] }, id: string) => {
      const item = raw.data?.[0];
      const text = item?.fields?.body || `No body text available for ${id}.`;
      return {
        title: item?.fields?.title || id,
        authors: [],
        year: yearOf(item?.fields?.date?.created),
        ...truncateText(text),
      };
    },
  },
});
