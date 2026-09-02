// GitHub Security Advisories. Works keyless (60 req/h against the shared
// GitHub API pool); GITHUB_TOKEN, if present, buys a much higher rate.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.github.com';

interface GhsaAdvisory {
  ghsa_id: string;
  summary?: string;
  description?: string;
  published_at?: string;
  html_url: string;
}

function authHeaders(): Record<string, string> | undefined {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export function normalizeGhsa(item: GhsaAdvisory): LibraryResult {
  const year = item.published_at ? new Date(item.published_at).getFullYear() : undefined;
  return {
    id: item.ghsa_id,
    source: 'ghsa',
    title: item.summary || item.ghsa_id,
    authors: [],
    year: Number.isFinite(year) ? year : undefined,
    hasFullText: Boolean(item.description),
    description: item.description,
    published: item.published_at,
    previewUrl: item.html_url,
  };
}

defineRest<GhsaAdvisory[]>({
  name: 'ghsa',
  description:
    'GitHub Security Advisories: advisories curated by GitHub across public repositories and package ecosystems. Works keyless (60 req/h); set GITHUB_TOKEN for a higher rate.',
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://github.com/advisories',
  supportsIngest: true,
  verifiedAt: '2026-09-01',
  headers: authHeaders(),
  pacing: { minIntervalMs: process.env.GITHUB_TOKEN ? 750 : 60_000 },
  search: {
    url: (q, limit) => `${BASE}/advisories?keywords=${encodeURIComponent(q)}&per_page=${limit}`,
    pick: (raw) => raw,
    normalize: normalizeGhsa,
  },
  read: {
    url: (id) => `${BASE}/advisories/${encodeURIComponent(id)}`,
    normalize: (raw: GhsaAdvisory) => ({
      title: raw.summary || raw.ghsa_id,
      authors: [],
      year: raw.published_at ? new Date(raw.published_at).getFullYear() : undefined,
      ...truncateText(
        raw.description || raw.summary || `No description available for ${raw.ghsa_id}.`,
      ),
    }),
  },
});
