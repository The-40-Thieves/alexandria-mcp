// OpenCitations Index v2 (api.opencitations.net/index/v2): an open
// citation graph. Rather than a keyword search, `search(query)` treats
// `query` as a DOI and returns the works that cite it (each itself
// identified by its own DOI, so it can be fed back into read()); `read(id)`
// treats `id` as a DOI and returns its outgoing reference list as text.
// supportsIngest: false - this source has no article text to store, only
// citation edges. Task 7's library_citations tool calls this adapter
// directly as its fallback (search() for citing works, read() for
// references), matching the shape brief 06 asks for.
//
// Neither the DOI in the URL path nor the ones embedded in "citing"/
// "cited" are percent-encoded here: OpenCitations' own path scheme treats
// everything after "citations/"/"references/" as one raw identifier
// (verified live 2026-09-03 - a DOI's internal "/" is NOT escaped in a
// working request), so encodeURIComponent would break the very thing it's
// meant to protect by turning that "/" into "%2F".
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.opencitations.net/index/v2';

interface OcCitation {
  oci: string;
  citing: string;
  cited: string;
  creation?: string;
  timespan?: string;
}

function accessTokenHeader(): Record<string, string> {
  const token = process.env.OPENCITATIONS_ACCESS_TOKEN;
  return token ? { authorization: token } : {};
}

// "citing"/"cited" are space-separated pid lists like
// "omid:br/0629059472 doi:10.1063/1.5011231 openalex:W3100592981"; pulls
// out just the doi: token.
function extractDoi(pidList: string): string | undefined {
  return pidList.match(/\bdoi:(\S+)/)?.[1];
}

function yearFrom(creation?: string): number | undefined {
  const year = creation ? Number(creation.slice(0, 4)) : Number.NaN;
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeOcCitingWork(citation: OcCitation): LibraryResult | null {
  const doi = extractDoi(citation.citing);
  if (!doi) return null;
  return {
    id: doi,
    source: 'opencitations',
    title: `Citing work (doi:${doi})`,
    authors: [],
    year: yearFrom(citation.creation),
    hasFullText: false,
    previewUrl: `https://doi.org/${doi}`,
    description: citation.timespan ? `Cited ${citation.timespan} after publication` : undefined,
  };
}

export async function opencitationsSearch(doi: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<OcCitation[]>(`${BASE}/citations/doi:${doi}`, {
    headers: accessTokenHeader(),
  });
  const results: LibraryResult[] = [];
  for (const citation of data) {
    const r = normalizeOcCitingWork(citation);
    if (r) results.push(r);
    if (results.length >= limit) break;
  }
  return results;
}

export async function opencitationsRead(doi: string): Promise<ReadResult> {
  const data = await fetchJSON<OcCitation[]>(`${BASE}/references/doi:${doi}`, {
    headers: accessTokenHeader(),
  });
  const lines = data
    .map((ref, i) => {
      const citedDoi = extractDoi(ref.cited);
      return `${i + 1}. ${citedDoi ? `doi:${citedDoi}` : ref.cited}`;
    })
    .join('\n');
  return {
    title: `References for doi:${doi}`,
    authors: [],
    ...truncateText(lines || `No references found for doi:${doi}.`),
  };
}

register('opencitations', {
  description:
    'OpenCitations Index v2: an open citation graph. search(doi) returns citing works; read(doi) returns the outgoing reference list. No article text - not ingestible. Optional OPENCITATIONS_ACCESS_TOKEN for a higher rate limit.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://opencitations.net',
  verifiedAt: '2026-09-03',
  optionalEnv: ['OPENCITATIONS_ACCESS_TOKEN'],
  // 180 requests/minute per IP, documented.
  pacing: { minIntervalMs: 334 },
  search: opencitationsSearch,
  read: opencitationsRead,
});
