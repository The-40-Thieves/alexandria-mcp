// NIST NVD: the National Vulnerability Database. Works keyless at a slow
// pace (public rate limit); NVD_API_KEY, if present, is sent as the apiKey
// header and buys a much faster pace.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

interface NvdCve {
  id: string;
  published?: string;
  descriptions?: Array<{ lang: string; value: string }>;
}

interface NvdSearchResponse {
  vulnerabilities?: Array<{ cve: NvdCve }>;
}

function englishDescription(cve: NvdCve): string | undefined {
  return cve.descriptions?.find((d) => d.lang === 'en')?.value;
}

function yearOf(published: string | undefined): number | undefined {
  if (!published) return undefined;
  const year = new Date(published).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeNvd(entry: { cve: NvdCve }): LibraryResult {
  const description = englishDescription(entry.cve);
  return {
    id: entry.cve.id,
    source: 'nvd',
    title: description ? `${entry.cve.id}: ${description.slice(0, 80)}` : entry.cve.id,
    authors: [],
    year: yearOf(entry.cve.published),
    hasFullText: Boolean(description),
    description,
    published: entry.cve.published,
    previewUrl: `https://nvd.nist.gov/vuln/detail/${entry.cve.id}`,
  };
}

const apiKey = process.env.NVD_API_KEY;

defineRest<NvdSearchResponse>({
  name: 'nvd',
  description:
    'NIST NVD: the National Vulnerability Database, CVE records enriched with CVSS scores and CPE matches. Works keyless at a slow pace; set NVD_API_KEY for a faster one.',
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://nvd.nist.gov',
  supportsIngest: true,
  verifiedAt: '2026-09-01',
  headers: apiKey ? { apiKey } : undefined,
  pacing: { minIntervalMs: apiKey ? 700 : 6500 },
  search: {
    url: (q, limit) => `${BASE}?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=${limit}`,
    pick: (raw) => raw.vulnerabilities ?? [],
    normalize: normalizeNvd,
  },
  read: {
    url: (id) => `${BASE}?cveId=${encodeURIComponent(id)}`,
    normalize: (raw: NvdSearchResponse, id: string) => {
      const entry = raw.vulnerabilities?.[0];
      if (!entry) {
        return { title: id, authors: [], ...truncateText(`No CVE record found for ${id}.`) };
      }
      const description = englishDescription(entry.cve) ?? `No description available for ${id}.`;
      return {
        title: id,
        authors: [],
        year: yearOf(entry.cve.published),
        ...truncateText(description),
      };
    },
  },
});
