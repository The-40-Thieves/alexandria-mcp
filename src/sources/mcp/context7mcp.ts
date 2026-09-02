// Context7's own MCP server: search = resolve-library-id, read =
// query-docs. Keyless; CONTEXT7_API_KEY, if set, is sent as a bearer
// header for a higher rate (same convention as the existing REST
// context7 source in src/sources/context7.ts, kept alongside this one
// per the task-5.1 brief). query-docs is a topic-scoped question, not a
// "dump the whole library" call, but read(id) has no room for the
// original search query; it falls back to a broad, generic query (see
// DEFAULT_READ_QUERY) rather than nothing, and a caller who wants a
// specific topic should search() with that topic instead.
import type { LibraryResult, ReadResult } from '../../types.js';
import type { RemoteServerConfig } from '../../utils/mcpClientPool.js';
import { defineMcpSource } from '../kinds/mcp.js';
import { truncateText } from '../registry.js';

const DEFAULT_READ_QUERY = 'overview and getting started';

function server(): RemoteServerConfig {
  const key = process.env.CONTEXT7_API_KEY;
  return {
    name: 'context7mcp',
    url: 'https://mcp.context7.com/mcp',
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    timeoutMs: 25000,
  };
}

// resolve-library-id's response is plain text, not structuredContent (no
// outputSchema on this tool as of 2026-09-02): a list of library entries
// separated by a `----------` line, each formatted as
// "- Title: X\n- Context7-compatible library ID: Y\n- Description: Z\n...".
export function parseLibraryList(
  text: string,
): Array<{ title: string; id: string; description?: string }> {
  const blocks = text.split(/\n-{5,}\n/);
  const out: Array<{ title: string; id: string; description?: string }> = [];
  for (const block of blocks) {
    const title = block.match(/-\s*Title:\s*(.+)/)?.[1]?.trim();
    const id = block.match(/-\s*Context7-compatible library ID:\s*(.+)/)?.[1]?.trim();
    const description = block.match(/-\s*Description:\s*(.+)/)?.[1]?.trim();
    if (title && id) out.push({ title, id, description });
  }
  return out;
}

export function normalizeContext7Mcp(text: string): LibraryResult[] {
  return parseLibraryList(text).map((lib) => ({
    id: lib.id,
    source: 'context7mcp',
    title: lib.title,
    authors: [],
    hasFullText: Boolean(lib.description),
    description: lib.description,
    previewUrl: `https://context7.com${lib.id}`,
  }));
}

export function normalizeContext7McpRead(text: string, id: string): ReadResult {
  return {
    title: id,
    authors: [],
    ...truncateText(text || `No documentation found for ${id}.`),
  };
}

defineMcpSource({
  name: 'context7mcp',
  description:
    'Context7 documentation search via its own MCP server (resolve-library-id then query-docs). Works keyless; set CONTEXT7_API_KEY for a higher rate. Additive to the existing context7 REST source. read() cannot target a specific topic (query-docs needs one but read(id) carries no query), so it uses a generic default query; search() again with a specific topic for targeted docs.',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://context7.com',
  supportsIngest: true,
  server,
  search: {
    tool: 'resolve-library-id',
    args: (q) => ({ query: q, libraryName: q }),
    normalize: (text) => normalizeContext7Mcp(text),
  },
  read: {
    tool: 'query-docs',
    args: (id) => ({ libraryId: id, query: DEFAULT_READ_QUERY }),
    normalize: (text, _structured, id) => normalizeContext7McpRead(text, id),
  },
  expectTools: ['resolve-library-id', 'query-docs'],
  verifiedAt: '2026-09-02',
});
