// EUVD: the European Union Vulnerability Database, run by ENISA. No API key
// required.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://euvdservices.enisa.europa.eu/api';

interface EuvdItem {
  id: string;
  description?: string;
  datePublished?: string;
}

interface EuvdSearchResponse {
  items?: EuvdItem[];
}

function yearOf(datePublished: string | undefined): number | undefined {
  if (!datePublished) return undefined;
  const year = new Date(datePublished).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeEuvd(item: EuvdItem): LibraryResult | null {
  if (!item.id) return null;
  const description = item.description;
  return {
    id: item.id,
    source: 'euvd',
    title: description ? `${item.id}: ${description.slice(0, 80)}` : item.id,
    authors: [],
    year: yearOf(item.datePublished),
    hasFullText: Boolean(description),
    description,
    published: item.datePublished,
    previewUrl: `https://euvd.enisa.europa.eu/vulnerability/${item.id}`,
  };
}

defineRest<EuvdSearchResponse>({
  name: 'euvd',
  description:
    "EUVD: the European Union Vulnerability Database, ENISA's aggregation of CVE, GHSA and vendor advisories. No API key required.",
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://euvd.enisa.europa.eu',
  supportsIngest: true,
  verifiedAt: '2026-09-01',
  search: {
    url: (q, limit) => `${BASE}/search?text=${encodeURIComponent(q)}&size=${limit}`,
    pick: (raw) => raw.items ?? [],
    normalize: normalizeEuvd,
  },
  read: {
    url: (id) => `${BASE}/enisaid?id=${encodeURIComponent(id)}`,
    normalize: (raw: EuvdItem, id: string) => ({
      title: id,
      authors: [],
      year: yearOf(raw.datePublished),
      ...truncateText(raw.description || `No description available for ${id}.`),
    }),
  },
});
