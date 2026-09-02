// Context7: up-to-date library documentation search, indexed by library id.
// Works keyless; CONTEXT7_API_KEY, if set, is sent as a bearer header for a
// higher rate. A custom register() rather than defineRest(): the context
// endpoint (read()) returns plain text, not JSON, so defineRest()'s
// JSON-only read() doesn't fit. Kept alongside the `mcp`-kind variant of
// this source (context7mcp), which supersedes it for routing; this REST
// source stays registered and callable by name.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://context7.com/api/v2';

interface Context7Library {
  id: string;
  title: string;
  description?: string;
}

interface Context7SearchResponse {
  results?: Context7Library[];
}

function authHeaders(): Record<string, string> {
  const key = process.env.CONTEXT7_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function normalizeContext7(lib: Context7Library): LibraryResult {
  return {
    id: lib.id,
    source: 'context7',
    title: lib.title,
    authors: [],
    hasFullText: Boolean(lib.description),
    description: lib.description,
    previewUrl: `https://context7.com${lib.id}`,
  };
}

export async function context7Search(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<Context7SearchResponse>(
    `${BASE}/libs/search?query=${encodeURIComponent(query)}`,
    { headers: authHeaders() },
  );
  return (data.results ?? []).slice(0, limit).map(normalizeContext7);
}

export async function context7Read(id: string): Promise<ReadResult> {
  const text = await fetchText(`${BASE}/context?libraryId=${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  return {
    title: id,
    authors: [],
    ...truncateText(text || `No documentation snippets found for ${id}.`),
  };
}

register('context7', {
  description:
    'Context7: up-to-date library and framework documentation, indexed by library id (e.g. /reactjs/react.dev). Works keyless; set CONTEXT7_API_KEY for a higher rate.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://context7.com',
  // Superseded for routing by the context7mcp source, which talks to the
  // upstream MCP server directly. Hidden rather than removed: it stays
  // registered and callable by name. Unlike mdnmcp, context7mcp declares no
  // fallback to this source, so it is reachable only by explicit name.
  hidden: true,
  verifiedAt: '2026-09-01',
  // Raises the anonymous rate limit; the source works without one.
  optionalEnv: ['CONTEXT7_API_KEY'],
  search: context7Search,
  read: context7Read,
});
