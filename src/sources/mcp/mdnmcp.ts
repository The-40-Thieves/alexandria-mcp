// MDN's own MCP server: search = search, read = get-doc. No API key
// required. Additive to the existing REST mdn source in
// src/sources/mdn.ts, which uses MDN's public search API instead; this
// one is the official MCP surface and, unlike the REST source, can
// return full document text for read().
import type { LibraryResult, ReadResult } from '../../types.ts';
import type { RemoteServerConfig } from '../../utils/mcpClientPool.ts';
import { defineMcpSource } from '../kinds/mcp.ts';
import { truncateText } from '../registry.ts';

const SERVER: RemoteServerConfig = {
  name: 'mdnmcp',
  url: 'https://mcp.mdn.mozilla.net/',
  timeoutMs: 25000,
};

interface MdnHit {
  title: string;
  path?: string;
  summary?: string;
}

// search's response is plain text (no outputSchema as of 2026-09-02): a
// list of entries, each "# Title\n`path`: `/en-US/docs/...`\n`compat-key`:
// `...`\n<summary paragraph>", separated by a blank line before the next
// "# ".
export function parseMdnSearch(text: string): MdnHit[] {
  const blocks = text.split(/\n(?=#\s)/);
  const out: MdnHit[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block.startsWith('#')) continue;
    const lines = block.split('\n');
    const title = lines[0].replace(/^#\s*/, '').trim();
    if (!title) continue;
    let path: string | undefined;
    const summaryLines: string[] = [];
    for (const line of lines.slice(1)) {
      const pathMatch = line.match(/`path`:\s*`([^`]+)`/);
      if (pathMatch) {
        path = pathMatch[1];
        continue;
      }
      if (/`compat-key`:/.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed) summaryLines.push(trimmed);
    }
    out.push({ title, path, summary: summaryLines.join(' ') || undefined });
  }
  return out;
}

export function normalizeMdnMcp(text: string): LibraryResult[] {
  return parseMdnSearch(text).map((hit) => ({
    id: hit.path ?? hit.title,
    source: 'mdnmcp',
    title: hit.title,
    authors: [],
    hasFullText: Boolean(hit.path),
    description: hit.summary,
    url: hit.path ? `https://developer.mozilla.org${hit.path}` : undefined,
  }));
}

export function normalizeMdnMcpRead(text: string, id: string): ReadResult {
  return {
    title: id,
    authors: [],
    ...truncateText(text || `No document found for ${id}.`),
  };
}

defineMcpSource({
  name: 'mdnmcp',
  description:
    "MDN Web Docs's own MCP server: web platform reference and guides, with full document text via get-doc. No API key required. Additive to the existing mdn REST source, which it falls back to when the MCP server is unreachable.",
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://developer.mozilla.org',
  supportsIngest: true,
  server: SERVER,
  search: {
    tool: 'search',
    args: (q) => ({ query: q }),
    normalize: (text) => normalizeMdnMcp(text),
  },
  read: {
    tool: 'get-doc',
    args: (id) => ({ path: id }),
    normalize: (text, _structured, id) => normalizeMdnMcpRead(text, id),
  },
  // The REST mdn source hits MDN's own public search API directly; when
  // this MCP server is down, fall back to it rather than surface an
  // error for what search-wise is the same underlying content.
  fallback: 'mdn',
  expectTools: ['search', 'get-doc', 'get-compat'],
  verifiedAt: '2026-09-02',
});
