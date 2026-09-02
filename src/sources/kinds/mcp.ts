// The MCP-delegation adapter kind. defineMcpSource() registers a source
// whose search()/read() call out to a remote MCP server's tools/call via
// the shared McpClientPool (utils/mcpClientPool.ts), instead of talking
// to a REST/RSS endpoint directly. Tool names are internal to each spec;
// they are never prefixed or exposed through this repo's own tool
// surface (registry.ts's SourceAdapter shape is identical to every other
// kind's).
import type { LibraryResult, ReadResult } from '../../types.js';
import { pool, type RemoteServerConfig, TOOL_ERROR_PREFIX } from '../../utils/mcpClientPool.js';
import type { AuthSpec, Cluster, Freshness } from '../registry.js';
import { getAdapter, register } from '../registry.js';

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
    // Optional validation of the caller-supplied id, run before the server
    // is resolved and outside the fallback catch below, so a rejected id
    // reaches neither the remote MCP server nor a fallback adapter. Used by
    // sources whose read() id is a URL the remote server will fetch on our
    // behalf (jina's read_url), where the SSRF guard has to happen here.
    guard?: (id: string) => Promise<void>;
  };
  // The name of another registered source to delegate to when the MCP
  // server is unreachable: `server` resolves to null, or pool.call()
  // fails with a transport-class error (after its own single retry).
  // A tool-level error (pool.call() throwing because the tool's own
  // result had isError: true, prefixed TOOL_ERROR_PREFIX) does NOT fall
  // back - that's the server working correctly and reporting a real
  // failure, not a reason to route around it.
  fallback?: string;
  expectTools?: string[];
  // Informational only for this kind: visibility is already decided by
  // whether `server` resolves (a spec whose server() returns null without
  // its token is hidden). Declaring it keeps the generated docs and
  // .env.example honest about which env var gates the source.
  auth?: AuthSpec;
  optionalEnv?: string[];
  timeoutMs?: number;
  verifiedAt?: string;
}

function isToolLevelError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(TOOL_ERROR_PREFIX);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs the fallback adapter's call. If IT also throws, the original
// failure (why the MCP call itself needed a fallback) would otherwise be
// discarded in favor of whatever the fallback threw - wraps both
// messages into one Error instead, so a caller/log sees both causes.
async function callFallback<T>(
  name: string,
  fallbackName: string,
  originalErr: unknown,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (fallbackErr) {
    throw new Error(
      `${name}: MCP call failed (${errorMessage(originalErr)}); fallback ${fallbackName} also failed (${errorMessage(fallbackErr)})`,
    );
  }
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
  spec: Pick<McpSourceSpec, 'name' | 'server' | 'search' | 'fallback'>,
  timeoutMs: number,
): (query: string, limit: number) => Promise<LibraryResult[]> {
  return async (query, limit) => {
    const server = resolveServer(spec as McpSourceSpec);
    if (!server) {
      const notConfigured = notConfiguredError(spec.name);
      if (spec.fallback) {
        const fallback = spec.fallback;
        return callFallback(spec.name, fallback, notConfigured, () =>
          getAdapter(fallback).search(query, limit),
        );
      }
      throw notConfigured;
    }
    try {
      const { text, structured } = await pool.call(
        { ...server, timeoutMs: server.timeoutMs ?? timeoutMs },
        spec.search.tool,
        spec.search.args(query, limit),
      );
      return spec.search.normalize(text, structured, query).slice(0, limit);
    } catch (err) {
      if (spec.fallback && !isToolLevelError(err)) {
        const fallback = spec.fallback;
        return callFallback(spec.name, fallback, err, () =>
          getAdapter(fallback).search(query, limit),
        );
      }
      throw err;
    }
  };
}

export function defineMcpSource(spec: McpSourceSpec): void {
  const timeoutMs = spec.timeoutMs ?? 25000;
  const search = buildSearch(spec, timeoutMs);

  async function read(id: string): Promise<ReadResult> {
    if (!spec.read) throw new Error(`${spec.name} does not support read()`);
    if (spec.read.guard) await spec.read.guard(id);
    const server = resolveServer(spec);
    if (!server) {
      const notConfigured = notConfiguredError(spec.name);
      if (spec.fallback) {
        const fallback = spec.fallback;
        return callFallback(spec.name, fallback, notConfigured, () =>
          getAdapter(fallback).read(id),
        );
      }
      throw notConfigured;
    }
    try {
      const { text, structured } = await pool.call(
        { ...server, timeoutMs: server.timeoutMs ?? timeoutMs },
        spec.read.tool,
        spec.read.args(id),
      );
      return spec.read.normalize(text, structured, id);
    } catch (err) {
      if (spec.fallback && !isToolLevelError(err)) {
        const fallback = spec.fallback;
        return callFallback(spec.name, fallback, err, () => getAdapter(fallback).read(id));
      }
      throw err;
    }
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
    auth: spec.auth,
    optionalEnv: spec.optionalEnv,
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
    auth: spec.auth,
    optionalEnv: spec.optionalEnv,
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
