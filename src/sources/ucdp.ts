// UCDP (Uppsala Conflict Data Program) Georeferenced Event Dataset:
// individual conflict-violence events, searchable by country. Requires
// UCDP_TOKEN (header x-ucdp-access-token). A custom register() rather than
// defineRest(): the GED API has no documented per-event-id lookup, so
// read() returns metadata pointing back at UCDP rather than guessing at an
// unverified filter parameter.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://ucdpapi.pcr.uu.se/api/gedevents/26.1';

const VIOLENCE_TYPE: Record<number, string> = {
  1: 'State-based violence',
  2: 'Non-state violence',
  3: 'One-sided violence',
};

interface UcdpEvent {
  id: number;
  type_of_violence?: number;
  side_a?: string;
  side_b?: string;
  country?: string;
  date_start?: string;
  best?: number;
}

interface UcdpResponse {
  Result?: UcdpEvent[];
}

function token(): string {
  const t = process.env.UCDP_TOKEN;
  if (!t) throw new Error('ucdp requires UCDP_TOKEN');
  return t;
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeUcdp(item: UcdpEvent): LibraryResult {
  const violence = item.type_of_violence ? VIOLENCE_TYPE[item.type_of_violence] : undefined;
  const parties = [item.side_a, item.side_b].filter(Boolean).join(' vs ');
  return {
    id: String(item.id),
    source: 'ucdp',
    title: [violence, parties].filter(Boolean).join(': ') || `UCDP event ${item.id}`,
    authors: [],
    year: yearOf(item.date_start),
    hasFullText: false,
    description: item.country
      ? `${item.country}, ${item.best ?? 0} fatalities`
      : `${item.best ?? 0} fatalities`,
    published: item.date_start,
  };
}

export async function ucdpSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<UcdpResponse>(
    `${BASE}?pagesize=${limit}&Country=${encodeURIComponent(query)}`,
    { headers: { 'x-ucdp-access-token': token() } },
  );
  return (data.Result ?? []).map(normalizeUcdp);
}

export async function ucdpRead(id: string): Promise<ReadResult> {
  token();
  return {
    title: `UCDP event ${id}`,
    authors: [],
    metadataOnly: true,
    externalUrl: 'https://ucdp.uu.se',
    note: "UCDP's GED API has no documented per-event lookup; search again with a country filter for full event details.",
  };
}

register('ucdp', {
  description:
    'UCDP (Uppsala Conflict Data Program) Georeferenced Event Dataset: individually coded events of organized violence, searchable by country. Requires free UCDP_TOKEN.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'geopolitical',
  freshness: 'daily',
  homepage: 'https://ucdp.uu.se',
  auth: { type: 'header', env: 'UCDP_TOKEN', header: 'x-ucdp-access-token' },
  pacing: { dailyCap: 4500 },
  search: ucdpSearch,
  read: ucdpRead,
});
