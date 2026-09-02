// GitHub's official Copilot MCP server: search = search_code, read =
// get_file_contents. Requires GITHUB_TOKEN (a personal access token or
// OAuth token with repo/code-search scope); hidden without one, since
// the server returns 401 for an unauthenticated connection. This
// deployment has no GITHUB_TOKEN configured, so the source is hidden
// here; tools/list and both tool calls were verified live against
// https://api.githubcopilot.com/mcp/ on 2026-09-02 using the operator's
// own gh CLI token for that one-off check only (not read from or written
// to this deployment's env) - see the task-5 report.
import type { LibraryResult, ReadResult } from '../../types.js';
import type { RemoteServerConfig } from '../../utils/mcpClientPool.js';
import { defineMcpSource } from '../kinds/mcp.js';
import { truncateText } from '../registry.js';

function server(): RemoteServerConfig | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return {
    name: 'githubmcp',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 25000,
  };
}

// search_code's response is a JSON string (not structuredContent; no
// outputSchema on the tool) matching a trimmed form of GitHub's code
// search REST API: { total_count, incomplete_results, items: [{ name,
// path, sha, repository: "owner/repo", text_matches? }] }. Unlike the
// raw REST API (used by the existing githubsearch REST source), the MCP
// tool's `repository` field is a plain "owner/repo" string, not an
// object, and it omits html_url/git_url/url entirely - confirmed with a
// live call on 2026-09-02.
interface GithubCodeSearchItem {
  name?: string;
  path?: string;
  sha?: string;
  repository?: string;
}
interface GithubCodeSearchResponse {
  items?: GithubCodeSearchItem[];
}

export function normalizeGithubMcpSearch(text: string): LibraryResult[] {
  let data: GithubCodeSearchResponse;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const results: LibraryResult[] = [];
  for (const item of data.items ?? []) {
    if (!item.path || !item.repository) continue;
    results.push({
      id: `${item.repository}#${item.path}`,
      source: 'githubmcp',
      title: `${item.repository}: ${item.path}`,
      authors: [],
      hasFullText: true,
      url: `https://github.com/${item.repository}/blob/HEAD/${item.path}`,
    });
  }
  return results;
}

// Splits the `owner/repo#path` id (matching githubsearch.ts's REST
// source convention, for consistency between the two) back into
// get_file_contents' required {owner, repo, path} arguments.
export function splitGithubMcpId(id: string): { owner: string; repo: string; path: string } {
  const hashIndex = id.indexOf('#');
  const repository = hashIndex === -1 ? id : id.slice(0, hashIndex);
  const path = hashIndex === -1 ? '' : id.slice(hashIndex + 1);
  const slashIndex = repository.indexOf('/');
  const owner = slashIndex === -1 ? repository : repository.slice(0, slashIndex);
  const repo = slashIndex === -1 ? '' : repository.slice(slashIndex + 1);
  return { owner, repo, path };
}

// get_file_contents returns a one-line text summary plus the actual file
// content as an embedded-text `resource` content item; McpClientPool
// pulls both into `text`, joined by a blank line, so the file content is
// everything after the first blank line rather than the whole string
// (which would otherwise prepend the "successfully downloaded..." line
// to every read result).
export function normalizeGithubMcpRead(text: string, id: string): ReadResult {
  const blankLine = text.indexOf('\n\n');
  const fileText = blankLine === -1 ? text : text.slice(blankLine + 2);
  return {
    title: id,
    authors: [],
    ...truncateText(fileText || `No content found for ${id}.`),
  };
}

defineMcpSource({
  name: 'githubmcp',
  description:
    'GitHub code search via the official Copilot MCP server (search_code, get_file_contents). Requires GITHUB_TOKEN; hidden without it.',
  cluster: 'developer',
  freshness: 'realtime',
  homepage: 'https://github.com',
  supportsIngest: true,
  server,
  search: {
    tool: 'search_code',
    args: (q, limit) => ({ query: q, perPage: Math.min(Math.max(limit, 1), 100) }),
    normalize: (text) => normalizeGithubMcpSearch(text),
  },
  read: {
    tool: 'get_file_contents',
    args: (id) => splitGithubMcpId(id),
    normalize: (text, _structured, id) => normalizeGithubMcpRead(text, id),
  },
  expectTools: ['search_code', 'get_file_contents'],
  verifiedAt: '2026-09-02',
});
