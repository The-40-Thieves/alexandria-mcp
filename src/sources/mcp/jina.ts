// Jina AI's MCP server: search_web/read_url for the `jina` source, and
// (since the server exposes it) search_arxiv as a second source,
// `jinaarxiv`, whose read() delegates to the existing arxiv source
// (every hit's arxiv_id is a bare arXiv id). Keyless connection and
// tools/list work without a key; JINA_API_KEY, if set, is sent as a
// bearer header (confirmed live on 2026-09-02: without a key, search_web
// and search_arxiv both return a one-line "Unauthorized" error result
// rather than throwing, which splitHits() below drops, leaving zero
// hits rather than a crash).
import type { LibraryResult, ReadResult } from '../../types.js';
import type { RemoteServerConfig } from '../../utils/mcpClientPool.js';
import { defineMcpSource, defineMcpSourceWithDelegatedRead } from '../kinds/mcp.js';
import { getAdapter, truncateText } from '../registry.js';

function server(name: string): RemoteServerConfig {
  const key = process.env.JINA_API_KEY;
  return {
    name,
    url: 'https://mcp.jina.ai/v1',
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    timeoutMs: 25000,
  };
}

interface JinaHit {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  authors?: string[];
  arxiv_id?: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// jina's search_web/search_arxiv tools return one YAML-formatted text
// content item per hit (a flat object: title/url/snippet/date, plus
// authors/arxiv_id for search_arxiv), not structuredContent (no
// outputSchema on either tool as of 2026-09-02). This is a minimal
// parser for exactly that shape, not a general YAML parser: flat scalar
// fields (including a multi-line folded scalar, which the `yaml` package
// wraps with plain indentation, no block-scalar marker) plus at most one
// string-array field (authors).
export function parseYamlHit(text: string): JinaHit & Record<string, unknown> {
  const hit: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentIsList = false;

  for (const line of text.split('\n')) {
    const topLevel = line.match(/^([A-Za-z_][\w]*):(.*)$/);
    if (topLevel) {
      currentKey = topLevel[1];
      const rest = topLevel[2].trim();
      if (rest === '') {
        hit[currentKey] = [];
        currentIsList = true;
      } else {
        hit[currentKey] = unquote(rest);
        currentIsList = false;
      }
      continue;
    }
    if (!currentKey) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentIsList) {
      (hit[currentKey] as string[]).push(unquote(listItem[1]));
      continue;
    }
    if (!currentIsList && typeof hit[currentKey] === 'string') {
      const cont = line.trim();
      if (cont) hit[currentKey] = `${hit[currentKey]} ${cont}`;
    }
  }
  return hit as JinaHit & Record<string, unknown>;
}

// McpClientPool.call() joins multiple text content items with a blank
// line (see mcpClientPool.ts); split back into per-hit blocks. A hit
// whose block starts with "Error:" (jina's own error formatting for a
// failed search, e.g. "Unauthorized" with no key) is dropped rather than
// mis-parsed as a hit with an "Error" field.
function splitHits(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && !b.startsWith('Error:'));
}

export function normalizeJinaWeb(text: string): LibraryResult[] {
  const results: LibraryResult[] = [];
  for (const hit of splitHits(text).map(parseYamlHit)) {
    if (!hit.url) continue;
    results.push({
      id: hit.url,
      source: 'jina',
      title: hit.title || hit.url,
      authors: [],
      hasFullText: true,
      description: hit.snippet,
      published: hit.date,
      url: hit.url,
    });
  }
  return results;
}

export function normalizeJinaArxiv(text: string): LibraryResult[] {
  const results: LibraryResult[] = [];
  for (const hit of splitHits(text).map(parseYamlHit)) {
    const id = hit.arxiv_id ?? hit.url;
    if (!id) continue;
    results.push({
      id,
      source: 'jinaarxiv',
      title: hit.title || id,
      authors: hit.authors ?? [],
      hasFullText: true,
      description: hit.snippet,
      published: hit.date,
      url: hit.url,
    });
  }
  return results;
}

export function normalizeJinaRead(text: string, id: string): ReadResult {
  return {
    title: id,
    authors: [],
    ...truncateText(text || `No content read for ${id}.`),
  };
}

// A jinaarxiv result with no arxiv_id (it fell back to its url as id)
// can't be delegated to the arxiv source; return metadata only rather
// than misinterpreting an arbitrary URL as an arXiv id.
async function jinaArxivFallbackRead(id: string): Promise<ReadResult> {
  return {
    title: id,
    authors: [],
    metadataOnly: true,
    externalUrl: id,
    note: 'This result has no arXiv id; only metadata is available.',
  };
}

defineMcpSource({
  name: 'jina',
  description:
    "Jina AI's live web search and page reader MCP server (search_web, read_url). Works keyless for connecting; set JINA_API_KEY for actual search/read calls (unauthenticated calls return an error result). cluster web, freshness realtime.",
  cluster: 'web',
  freshness: 'realtime',
  homepage: 'https://jina.ai',
  supportsIngest: true,
  server: () => server('jina'),
  search: {
    tool: 'search_web',
    args: (q, limit) => ({ query: q, num: Math.min(Math.max(limit, 1), 100) }),
    normalize: (text) => normalizeJinaWeb(text),
  },
  read: {
    tool: 'read_url',
    args: (id) => ({ url: id }),
    normalize: (text, _structured, id) => normalizeJinaRead(text, id),
  },
  expectTools: ['search_web', 'read_url'],
  // JINA_API_KEY is a feature env (it also enables fetch tier 2). The
  // server connects keyless; search calls need it in practice.
  optionalEnv: ['JINA_API_KEY'],
  verifiedAt: '2026-09-02',
});

defineMcpSourceWithDelegatedRead(
  {
    name: 'jinaarxiv',
    description:
      "Jina AI's search_arxiv tool: arXiv preprint search via the same MCP server as jina. Full text is read via the arxiv source when a result carries an arxiv_id. Works keyless for connecting; set JINA_API_KEY for actual search calls.",
    cluster: 'academic',
    freshness: 'daily',
    homepage: 'https://jina.ai',
    supportsIngest: true,
    server: () => server('jinaarxiv'),
    search: {
      tool: 'search_arxiv',
      args: (q, limit) => ({ query: q, num: Math.min(Math.max(limit, 1), 100) }),
      normalize: (text) => normalizeJinaArxiv(text),
    },
    expectTools: ['search_arxiv'],
    optionalEnv: ['JINA_API_KEY'],
    verifiedAt: '2026-09-02',
  },
  (id) => (/^\d{4}\.\d{4,5}$/.test(id) ? getAdapter('arxiv').read(id) : jinaArxivFallbackRead(id)),
);
