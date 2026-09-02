// CIRCL Vulnerability Lookup: full-text search across CVE, GHSA and other
// vulnerability feeds ingested by CIRCL. No API key required.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://vulnerability.circl.lu';

interface CirclReference {
  url: string;
}

interface CirclItem {
  cveMetadata: {
    cveId: string;
    datePublished?: string;
  };
  containers: {
    cna?: {
      descriptions?: Array<{ lang: string; value: string }>;
      references?: CirclReference[];
    };
  };
}

interface CirclSearchResponse {
  data: CirclItem[];
}

function firstDescription(item: CirclItem): string | undefined {
  return item.containers.cna?.descriptions?.find((d) => d.lang === 'en')?.value;
}

function yearOf(datePublished: string | undefined): number | undefined {
  if (!datePublished) return undefined;
  const year = new Date(datePublished).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeCircl(item: CirclItem): LibraryResult | null {
  const id = item.cveMetadata?.cveId;
  if (!id) return null;
  const description = firstDescription(item);
  return {
    id,
    source: 'circl',
    title: description ? `${id}: ${description.slice(0, 80)}` : id,
    authors: [],
    year: yearOf(item.cveMetadata.datePublished),
    hasFullText: Boolean(description),
    description,
    published: item.cveMetadata.datePublished,
    previewUrl: `${BASE}/vuln/${id}`,
  };
}

defineRest<CirclSearchResponse>({
  name: 'circl',
  description:
    "CIRCL Vulnerability Lookup: full-text search across CVE, GHSA and other vulnerability feeds, run by Luxembourg's CERT. No API key required.",
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://vulnerability.circl.lu',
  supportsIngest: true,
  verifiedAt: '2026-09-01',
  search: {
    url: (q, limit) =>
      `${BASE}/api/vulnerability/fulltext?q=${encodeURIComponent(q)}&page=1&per_page=${limit}`,
    pick: (raw) => raw.data ?? [],
    normalize: normalizeCircl,
  },
  read: {
    url: (id) => `${BASE}/api/vulnerability/${encodeURIComponent(id)}`,
    normalize: (raw: CirclItem, id: string) => {
      const description = firstDescription(raw) ?? `No description available for ${id}.`;
      const refs = raw.containers.cna?.references ?? [];
      const text = refs.length
        ? `${description}\n\nReferences:\n${refs.map((r) => r.url).join('\n')}`
        : description;
      return {
        title: id,
        authors: [],
        year: yearOf(raw.cveMetadata?.datePublished),
        ...truncateText(text),
      };
    },
  },
});
