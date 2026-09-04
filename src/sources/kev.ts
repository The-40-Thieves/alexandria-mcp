// CISA Known Exploited Vulnerabilities catalog: a single JSON document (no
// per-query search API), downloaded once per process and filtered
// client-side by token match, the same static-download convention as
// attack.ts, peps.ts, tc39.ts and swiftevolution.ts.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { contactUserAgent } from '../utils/userAgent.ts';
import { register } from './registry.ts';

const URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
// Final wave (F1): built from package.json's version via
// utils/userAgent.ts, not a literal frozen at `alexandria-mcp/10`.
const TIMEOUT_MS = 30000;

interface KevVulnerability {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  shortDescription?: string;
  dateAdded?: string;
}

interface KevCatalog {
  vulnerabilities: KevVulnerability[];
}

let cached: Promise<KevCatalog> | undefined;

function download(): Promise<KevCatalog> {
  if (!cached) {
    cached = fetchJSON<KevCatalog>(URL, { headers: { 'User-Agent': contactUserAgent() } }, TIMEOUT_MS).catch(
      (err) => {
        cached = undefined; // let a later call retry after a failed download
        throw err;
      },
    );
  }
  return cached;
}

function matches(item: KevVulnerability, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack =
    `${item.cveID} ${item.vendorProject} ${item.product} ${item.vulnerabilityName}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizeKev(item: KevVulnerability): LibraryResult {
  return {
    id: item.cveID,
    source: 'kev',
    title: item.vulnerabilityName,
    authors: [],
    hasFullText: Boolean(item.shortDescription),
    description: item.shortDescription,
    published: item.dateAdded,
    previewUrl: `https://nvd.nist.gov/vuln/detail/${item.cveID}`,
  };
}

export async function kevSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const catalog = await download();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.vulnerabilities
    .filter((item) => matches(item, tokens))
    .slice(0, limit)
    .map(normalizeKev);
}

export async function kevRead(id: string): Promise<ReadResult> {
  const catalog = await download();
  const item = catalog.vulnerabilities.find((v) => v.cveID === id);
  if (!item) throw new Error(`kev: ${id} not found in the KEV catalog`);
  return {
    title: item.vulnerabilityName,
    authors: [],
    metadataOnly: true,
    externalUrl: `https://nvd.nist.gov/vuln/detail/${item.cveID}`,
    note: item.shortDescription ?? 'No description available.',
  };
}

register('kev', {
  description:
    'CISA Known Exploited Vulnerabilities catalog: CVEs CISA has confirmed are being actively exploited. Downloaded once per process and filtered client-side; there is no per-query search API.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: kevSearch,
  read: kevRead,
});
