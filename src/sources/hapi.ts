// HDX HAPI (Humanitarian Data Exchange, Humanitarian API): coordination and
// conflict-event data. A query that resolves to a country via the ISO3
// lookup table in data/iso3-countries.ts fetches that country's conflict
// events directly; otherwise search() falls back to HAPI's location
// metadata search. Requires HDX_APP_IDENTIFIER (a self-serve base64 string,
// see https://hdx-hapi.readthedocs.io).
import type { LibraryResult } from '../types.js';
import { ISO3_COUNTRIES } from './data/iso3-countries.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://hapi.humdata.org/api/v2';

// Diacritic- and case-insensitive: an unaccented query like "Cote d'Ivoire"
// or "TURKIYE" needs to match the accented ISO short names in
// ISO3_COUNTRIES ("Cote d'Ivoire", "Turkiye"). NFD decomposes each accented
// character into a base letter plus a combining mark; stripping the
// combining marks block (U+0300 to U+036F) leaves the plain base letters.
function normalizeCountryKey(s: string): string {
  return s
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const ISO3_BY_NAME = new Map(
  ISO3_COUNTRIES.map(([name, code]) => [normalizeCountryKey(name), code]),
);

export function resolveIso3(query: string): string | undefined {
  return ISO3_BY_NAME.get(normalizeCountryKey(query));
}

interface HapiConflictEvent {
  location_code?: string;
  location_name?: string;
  admin1_name?: string;
  event_type?: string;
  events?: number;
  fatalities?: number;
  reference_period_start?: string;
}

interface HapiLocation {
  code?: string;
  name?: string;
  location_name?: string;
  location_code?: string;
}

interface HapiResponse<T> {
  data?: T[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeHapiConflictEvent(row: HapiConflictEvent): LibraryResult | null {
  const location = row.location_name || row.location_code;
  if (!location) return null;
  const id = `${row.location_code ?? location}:${row.event_type ?? 'event'}:${row.reference_period_start ?? ''}`;
  return {
    id,
    source: 'hapi',
    title: `${location}${row.admin1_name ? ` (${row.admin1_name})` : ''}: ${row.event_type ?? 'conflict events'}`,
    authors: [],
    year: yearOf(row.reference_period_start),
    hasFullText: true,
    description: `${row.events ?? 0} events, ${row.fatalities ?? 0} fatalities`,
    published: row.reference_period_start,
  };
}

export function normalizeHapiLocation(row: HapiLocation): LibraryResult | null {
  const name = row.name || row.location_name;
  const code = row.code || row.location_code;
  if (!name) return null;
  return {
    id: code || name,
    source: 'hapi',
    title: name,
    authors: [],
    hasFullText: false,
    description: code,
  };
}

defineRest<HapiResponse<HapiConflictEvent> | HapiResponse<HapiLocation>>({
  name: 'hapi',
  description:
    "HDX HAPI (Humanitarian Data Exchange, Humanitarian API): conflict-event and coordination data. A country-name query resolves to a conflict-events lookup; other queries search HAPI's location metadata. Requires free HDX_APP_IDENTIFIER (self-serve).",
  cluster: 'geopolitical',
  freshness: 'daily',
  homepage: 'https://hapi.humdata.org',
  supportsIngest: false,
  auth: { type: 'query', env: 'HDX_APP_IDENTIFIER', param: 'app_identifier' },
  search: {
    url: (q, limit) => {
      const iso3 = resolveIso3(q);
      return iso3
        ? `${BASE}/coordination-context/conflict-events?location_code=${iso3}&limit=${limit}`
        : `${BASE}/metadata/location?name=${encodeURIComponent(q)}&limit=${limit}`;
    },
    pick: (raw) => (raw as HapiResponse<unknown>).data ?? [],
    normalize: (item, q) =>
      resolveIso3(q)
        ? normalizeHapiConflictEvent(item as HapiConflictEvent)
        : normalizeHapiLocation(item as HapiLocation),
  },
  read: {
    // A conflict-event id looks like "ISO3:type:date" (see
    // normalizeHapiConflictEvent); a location id is a bare code or name.
    url: (id) => {
      const parts = id.split(':');
      return parts.length >= 3
        ? `${BASE}/coordination-context/conflict-events?location_code=${parts[0]}&limit=5`
        : `${BASE}/metadata/location?name=${encodeURIComponent(id)}&limit=5`;
    },
    normalize: (raw: HapiResponse<HapiConflictEvent> | HapiResponse<HapiLocation>, id: string) => {
      const parts = id.split(':');
      const rows = raw.data ?? [];
      const isConflictEvent = parts.length >= 3;
      const text = isConflictEvent
        ? (rows as HapiConflictEvent[])
            .map(
              (r) =>
                `${r.location_name ?? r.location_code} ${r.admin1_name ?? ''}: ${r.events ?? 0} events, ${r.fatalities ?? 0} fatalities (${r.reference_period_start ?? ''})`,
            )
            .join('\n')
        : (rows as HapiLocation[])
            .map((r) => `${r.name ?? r.location_name}: ${r.code ?? r.location_code}`)
            .join('\n');
      return { title: id, authors: [], ...truncateText(text || `No HAPI data found for ${id}.`) };
    },
  },
});
