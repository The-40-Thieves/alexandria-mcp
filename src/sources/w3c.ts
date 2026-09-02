// W3C specifications. api.w3.org's ?q= parameter is ignored server-side
// (verified live: it returns the same 1711-total, alphabetically-first
// page regardless of q), so this fetches the first 1000 specifications
// (embed=true, the server's own page-size ceiling) once per process and
// filters client-side by title token match, the same lazy-cache
// convention as kev.ts/attack.ts/peps.ts/tc39.ts/swiftevolution.ts.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { stripHtml } from '../utils/text-clean.js';
import { register } from './registry.js';

const URL = 'https://api.w3.org/specifications?items=1000&embed=true';
const TIMEOUT_MS = 30000;

interface W3cSpec {
  title: string;
  shortname: string;
  description?: string;
  _links: {
    'latest-version'?: { href: string };
  };
}

interface W3cSpecificationsResponse {
  _embedded: { specifications: W3cSpec[] };
}

let cached: Promise<W3cSpec[]> | undefined;

function download(): Promise<W3cSpec[]> {
  if (!cached) {
    cached = fetchJSON<W3cSpecificationsResponse>(URL, {}, TIMEOUT_MS)
      .then((data) => data._embedded.specifications)
      .catch((err) => {
        cached = undefined;
        throw err;
      });
  }
  return cached;
}

function matches(spec: W3cSpec, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${spec.title} ${spec.shortname}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizeW3c(spec: W3cSpec): LibraryResult {
  const description = spec.description ? stripHtml(spec.description) : undefined;
  return {
    id: spec.shortname,
    source: 'w3c',
    title: spec.title,
    authors: [],
    hasFullText: Boolean(description),
    description,
    url: spec._links['latest-version']?.href,
  };
}

export async function w3cSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const specs = await download();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return specs
    .filter((s) => matches(s, tokens))
    .slice(0, limit)
    .map(normalizeW3c);
}

export async function w3cRead(id: string): Promise<ReadResult> {
  const specs = await download();
  const spec = specs.find((s) => s.shortname === id);
  if (!spec) throw new Error(`w3c: ${id} not found`);
  return {
    title: spec.title,
    authors: [],
    metadataOnly: true,
    externalUrl: spec._links['latest-version']?.href,
    note: spec.description ? stripHtml(spec.description) : 'No description available.',
  };
}

register('w3c', {
  description:
    'W3C specifications: the first 1000 (of the full catalog), downloaded once per process and filtered client-side by title, since the upstream API ignores its own q= search parameter. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'standards',
  freshness: 'daily',
  homepage: 'https://www.w3.org/TR',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: w3cSearch,
  read: w3cRead,
});
