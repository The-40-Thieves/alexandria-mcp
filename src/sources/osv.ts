// OSV.dev: the Open Source Vulnerability database. A query is either a
// direct advisory id (CVE-, GHSA-, PYSEC-, RUSTSEC-, or GO-prefixed) for a
// single lookup, or an "ecosystem:name" pair (e.g. "npm:lodash") for a
// package's known vulnerabilities. OSV's query endpoint rejects a bare
// package name with no ecosystem ("invalid query"), so a plain word with no
// colon and no id shape returns no results rather than erroring.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.osv.dev/v1';
const ID_PATTERN = /^(CVE|GHSA|PYSEC|RUSTSEC|GO)-/i;
const ECOSYSTEM_NAME_PATTERN = /^([\w.-]+):(.+)$/;

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  modified?: string;
}

interface OsvQueryResponse {
  vulns?: OsvVuln[];
}

export function normalizeOsv(vuln: OsvVuln): LibraryResult {
  const year = vuln.modified ? new Date(vuln.modified).getFullYear() : undefined;
  return {
    id: vuln.id,
    source: 'osv',
    title: vuln.summary || vuln.id,
    authors: [],
    year: Number.isFinite(year) ? year : undefined,
    hasFullText: Boolean(vuln.details),
    description: vuln.details,
    previewUrl: `https://osv.dev/vulnerability/${vuln.id}`,
  };
}

export async function osvSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const trimmed = query.trim();
  if (ID_PATTERN.test(trimmed)) {
    const vuln = await fetchJSON<OsvVuln>(`${BASE}/vulns/${encodeURIComponent(trimmed)}`);
    return [normalizeOsv(vuln)];
  }
  const match = trimmed.match(ECOSYSTEM_NAME_PATTERN);
  if (!match) return [];
  const [, ecosystem, name] = match;
  const data = await fetchJSON<OsvQueryResponse>(`${BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name, ecosystem } }),
  });
  return (data.vulns ?? []).slice(0, limit).map(normalizeOsv);
}

export async function osvRead(id: string): Promise<ReadResult> {
  const vuln = await fetchJSON<OsvVuln>(`${BASE}/vulns/${encodeURIComponent(id)}`);
  const text = vuln.details || vuln.summary || `No details available for ${id}.`;
  return {
    title: vuln.summary || id,
    authors: [],
    year: vuln.modified ? new Date(vuln.modified).getFullYear() : undefined,
    ...truncateText(text),
  };
}

register('osv', {
  description:
    'OSV.dev: the Open Source Vulnerability database aggregating advisories from GitHub, PyPI, npm, RustSec and more. Query as a direct advisory id (CVE-/GHSA-/PYSEC-/RUSTSEC-/GO-prefixed) for one record, or as ecosystem:name (e.g. npm:lodash) for a package advisory list. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://osv.dev',
  verifiedAt: '2026-09-01',
  search: osvSearch,
  read: osvRead,
});
