// EPA Toxics Release Inventory (TRI): facility search by name. No API key
// required.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://data.epa.gov/efservice';

interface EpaTriFacility {
  tri_facility_id: string;
  facility_name: string;
  city_name?: string;
  state_abbr?: string;
}

type EpaTriSearchResponse = EpaTriFacility[];

export function normalizeEpatri(item: EpaTriFacility): LibraryResult | null {
  if (!item.tri_facility_id) return null;
  return {
    id: item.tri_facility_id,
    source: 'epatri',
    title: item.facility_name,
    authors: [],
    hasFullText: false,
    description: [item.city_name, item.state_abbr].filter(Boolean).join(', ') || undefined,
  };
}

defineRest<EpaTriSearchResponse>({
  name: 'epatri',
  description:
    "EPA Toxics Release Inventory (TRI): facility search by name, part of EPA's tracking of industrial toxic chemical releases. No API key required.",
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://www.epa.gov/toxics-release-inventory-tri-program',
  supportsIngest: false,
  verifiedAt: '2026-09-01',
  search: {
    url: (q, limit) =>
      `${BASE}/tri_facility/facility_name/CONTAINING/${encodeURIComponent(q)}/rows/0:${limit}/JSON`,
    pick: (raw) => raw ?? [],
    normalize: normalizeEpatri,
  },
  read: {
    url: (id) => `${BASE}/tri_facility/tri_facility_id/${encodeURIComponent(id)}/JSON`,
    normalize: (raw: EpaTriSearchResponse, id: string) => {
      const item = raw?.[0];
      if (!item) {
        return { title: id, authors: [], ...truncateText(`No TRI facility found for ${id}.`) };
      }
      const text = `${item.facility_name}\n${[item.city_name, item.state_abbr].filter(Boolean).join(', ')}`;
      return { title: item.facility_name || id, authors: [], ...truncateText(text) };
    },
  },
});
