// The MCP-delegation adapter kind. defineMcpSource() registers a source
// whose search()/read() call out to a remote MCP server's tools/call via
// the shared McpClientPool (utils/mcpClientPool.ts), instead of talking
// to a REST/RSS endpoint directly. Tool names are internal to each spec;
// they are never prefixed or exposed through this repo's own tool
// surface (registry.ts's SourceAdapter shape is identical to every other
// kind's).
import type { LibraryResult, ReadResult } from '../../types.js';
import { pool, type RemoteServerConfig } from '../../utils/mcpClientPool.js';
import type { Cluster, Freshness } from '../registry.js';
import { register } from '../registry.js';

export interface McpSourceSpec {
  name: string;
  description: string;
  cluster: Cluster;
  freshness: Freshness;
  homepage: string;
  supportsIngest: boolean;
  server: RemoteServerConfig | (() => RemoteServerConfig | null);
  search: {
    tool: string;
    args: (q: string, limit: number) => Record<string, unknown>;
    normalize: (text: string, structured: unknown, q: string) => LibraryResult[];
  };
  read?: {
    tool: string;
    args: (id: string) => Record<string, unknown>;
    normalize: (text: string, structured: unknown, id: string) => ReadResult;
  };
  expectTools?: string[];
  timeoutMs?: number;
  verifiedAt?: string;
}

// probe.ts's --mcp-snapshot flag and its live-drift warning both need
// each registered mcp source's server config and expected tool names.
// registry.ts's SourceAdapter has no room for either (it only knows
// search()/read()), and re-deriving them from the wrapped adapter isn't
// possible, so defineMcpSource() records them here as a side channel.
export interface McpProbeEntry {
  name: string;
  resolveServer: () => RemoteServerConfig | null;
  expectTools?: string[];
}
export const mcpProbeEntries: McpProbeEntry[] = [];

function resolveServer(spec: McpSourceSpec): RemoteServerConfig | null {
  return typeof spec.server === 'function' ? spec.server() : spec.server;
}

// Thrown when `server` resolves to null (missing required auth). The
// wording deliberately includes "requires" + "token" so
// scripts/probe.ts's classify() reports KEY_MISSING rather than ERROR
// for a source hidden this way, matching how defineRest()'s
// requireAuthValue() reads for a keyed REST source.
function notConfiguredError(name: string): Error {
  return new Error(`${name} requires an API token or credential that is not configured`);
}

// Shared by defineMcpSource() and defineMcpSourceWithDelegatedRead():
// builds the search() closure that resolves the server, calls the
// configured tool through the pool, and normalizes the result.
function buildSearch(
  spec: Pick<McpSourceSpec, 'name' | 'server' | 'search'>,
  timeoutMs: number,
): (query: string, limit: number) => Promise<LibraryResult[]> {
  return async (query, limit) => {
    const server = resolveServer(spec as McpSourceSpec);
    if (!server) throw notConfiguredError(spec.name);
    const { text, structured } = await pool.call(
      { ...server, timeoutMs: server.timeoutMs ?? timeoutMs },
      spec.search.tool,
      spec.search.args(query, limit),
    );
    return spec.search.normalize(text, structured, query).slice(0, limit);
  };
}

export function defineMcpSource(spec: McpSourceSpec): void {
  const timeoutMs = spec.timeoutMs ?? 25000;
  const search = buildSearch(spec, timeoutMs);

  async function read(id: string): Promise<ReadResult> {
    if (!spec.read) throw new Error(`${spec.name} does not support read()`);
    const server = resolveServer(spec);
    if (!server) throw notConfiguredError(spec.name);
    const { text, structured } = await pool.call(
      { ...server, timeoutMs: server.timeoutMs ?? timeoutMs },
      spec.read.tool,
      spec.read.args(id),
    );
    return spec.read.normalize(text, structured, id);
  }

  register(spec.name, {
    description: spec.description,
    supportsIngest: spec.supportsIngest,
    kind: 'mcp',
    cluster: spec.cluster,
    freshness: spec.freshness,
    homepage: spec.homepage,
    timeoutMs,
    verifiedAt: spec.verifiedAt,
    hidden: resolveServer(spec) === null,
    search,
    read,
  });

  mcpProbeEntries.push({
    name: spec.name,
    resolveServer: () => resolveServer(spec),
    expectTools: spec.expectTools,
  });
}

// For a source whose read() should bypass the MCP server entirely and
// delegate straight to a different, already-registered adapter (e.g.
// huggingface and jinaarxiv delegate to the arxiv source, since every
// result id from either is a bare arXiv id) rather than issue a
// tools/call of its own. defineMcpSource()'s own `read` spec always
// calls the pool, which doesn't fit a pure delegation, so this builds
// the same pooled, mcp-kind search() defineMcpSource() would (from a
// spec with no `read`) and registers it with the given `read` in place
// of one built from a tool spec.
export function defineMcpSourceWithDelegatedRead(
  spec: Omit<McpSourceSpec, 'read'>,
  read: (id: string) => Promise<ReadResult>,
): void {
  const timeoutMs = spec.timeoutMs ?? 25000;

  register(spec.name, {
    description: spec.description,
    supportsIngest: spec.supportsIngest,
    kind: 'mcp',
    cluster: spec.cluster,
    freshness: spec.freshness,
    homepage: spec.homepage,
    timeoutMs,
    verifiedAt: spec.verifiedAt,
    hidden: resolveServer(spec as McpSourceSpec) === null,
    search: buildSearch(spec, timeoutMs),
    read,
  });

  mcpProbeEntries.push({
    name: spec.name,
    resolveServer: () => resolveServer(spec as McpSourceSpec),
    expectTools: spec.expectTools,
  });
}
