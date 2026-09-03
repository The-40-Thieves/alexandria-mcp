// Read the Docs server-side search API v3: cross-project documentation
// search. No API key required for public projects. A custom register()
// rather than defineRest: read() retrieves the doc page itself through
// fetchAsText (SSRF-guarded), the same shape as mdn.ts, since a result's
// `id` is a third-party HTML page, not something this JSON API can return
// full text for directly.
//
// The API answers only a query scoped to a project via a `project:<slug>`
// prefix inside `q` - verified live 2026-09-03: `q=async await python`
// (no prefix) returns zero results, while `q=project:requests
// authentication` returns real matches. This adapter passes `query`
// straight through to `q`, so a caller must include that prefix to get
// anything back; the source description says so.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { stripHtml } from '../utils/text-clean.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

const SEARCH_URL = 'https://readthedocs.org/api/v3/search/';

interface RtdBlock {
  content?: string;
}
interface RtdProject {
  slug: string;
}
interface RtdResult {
  domain: string;
  path: string;
  title: string;
  project: RtdProject;
  blocks?: RtdBlock[];
}
interface RtdSearchResponse {
  results?: RtdResult[];
}

function pageUrl(result: RtdResult): string {
  return `${result.domain}${result.path}`;
}

export function normalizeReadthedocs(result: RtdResult): LibraryResult {
  return {
    id: pageUrl(result),
    source: 'readthedocs',
    title: result.title,
    authors: [],
    subjects: [result.project.slug],
    hasFullText: true,
    previewUrl: pageUrl(result),
    description: result.blocks?.[0]?.content
      ? stripHtml(result.blocks[0].content).slice(0, 300)
      : undefined,
  };
}

export async function readthedocsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<RtdSearchResponse>(
    `${SEARCH_URL}?q=${encodeURIComponent(query)}&page_size=${limit}`,
  );
  return (data.results ?? []).slice(0, limit).map(normalizeReadthedocs);
}

// The id is the doc page's own URL; fetchAsText's failure modes (a
// version-gated page, a non-HTML asset) are unrelated to a bug here, so a
// failure degrades to metadata-only, the same convention as mdn.ts.
export async function readthedocsRead(id: string): Promise<ReadResult> {
  try {
    const page = await fetchAsText(id);
    return { title: page.title || id, authors: [], externalUrl: id, ...truncateText(page.text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: id,
      note: `Full-text fetch failed; showing metadata only: ${message}`,
    };
  }
}

register('readthedocs', {
  description:
    'Read the Docs: server-side search across hosted project documentation. Scope a query to one project with a "project:<slug>" prefix (e.g. "project:requests authentication") - an unscoped query returns nothing. No API key required for public projects.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://readthedocs.org',
  verifiedAt: '2026-09-03',
  search: readthedocsSearch,
  read: readthedocsRead,
});
