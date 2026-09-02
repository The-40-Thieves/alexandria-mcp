// A small pool of MCP clients, one per remote server, reused across calls
// (a fresh Client per request would mean a fresh initialize handshake and
// SSE dial every time). Used by src/sources/kinds/mcp.ts's
// defineMcpSource() to delegate a source's search()/read() to a remote
// MCP server's tools/call.
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requestContext } from './http.ts';

export interface RemoteServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpCallResult {
  text: string;
  structured?: unknown;
}

const DEFAULT_TIMEOUT_MS = 20_000;
// Prefix on the Error call() throws for a tool-level failure
// (CallToolResult.isError: true). Exported so kinds/mcp.ts's fallback
// logic can distinguish "the tool ran and reported an error" (never
// falls back) from a transport-class failure (does).
export const TOOL_ERROR_PREFIX = 'tool error:';
const TOOLS_CACHE_MS = 60 * 60 * 1000; // 1 hour, per the task-5.1 brief

// Matches an error whose message, HTTP status code, or cause suggests the
// transport itself is broken (a dead session, a connection reset, an HTTP
// 4xx, a request timeout) as opposed to a normal tool-level error inside
// an otherwise successful response. Only the former should drop the
// cached client and retry. The SDK's StreamableHTTPError carries the
// status as a numeric `.code`, not in `.message` text, and a raw
// connection failure (server killed) surfaces as `fetch failed` with the
// real reason (e.g. ECONNREFUSED) on `.cause`, so both are checked
// alongside the message text.
//
// Deliberately NOT matched: /timeout/ and /timed out/. An aborted call is
// usually the CALLER's guard firing (registry.ts's withTimeout aborts the
// ambient signal once timeoutMs elapses), and retrying then issues a
// second request against a deadline that has already passed, doubling the
// load for a result nobody is waiting for. A genuinely dead transport
// still matches on ECONNRESET/ECONNREFUSED/EPIPE/`fetch failed`/a 4xx
// code, so dropping the timeout patterns costs no real detection.
export function isTransportTrouble(err: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 3; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      const code = (current as { code?: unknown }).code;
      if (code !== undefined) parts.push(String(code));
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const haystack = parts.join(' | ');
  return /\b4\d\d\b|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|session|not found/i.test(haystack);
}

// The SDK's StreamableHTTPClientTransport opens a second, standalone GET
// SSE connection right after the initialize handshake finishes, to carry
// server-initiated requests/notifications (list-changed, sampling,
// elicitation). This codebase uses none of that (no elicitation, no
// OAuth, per the task-5.1 brief), and against mcp.jina.ai specifically,
// leaving that stream open stalls every later request on the same client
// indefinitely: a live probe against https://mcp.jina.ai/v1 confirmed
// tools/list hanging past its own 70s timeout with the stream open, and
// returning in under 200ms with it suppressed. `_startOrAuthSse` is typed
// private in the SDK's .d.ts but not access-controlled at runtime; the
// cast below disables it. This is a documented workaround for a real,
// reproduced server interaction, not a guess.
function disableStandaloneSse(transport: StreamableHTTPClientTransport): void {
  (transport as unknown as { _startOrAuthSse: () => Promise<void> })._startOrAuthSse =
    async () => {};
}

interface PooledClient {
  client: Client;
}

// Two RemoteServerConfigs that point at the same URL with the same
// headers (e.g. `jina` and `jinaarxiv`, which both call
// https://mcp.jina.ai/v1) share one Client/connection rather than each
// opening its own, since `server.name` - which used to key the cache -
// is a per-source label, not a per-connection one. Different headers
// (e.g. different auth) still get their own client. The header
// component is hashed rather than embedded raw so a bearer token never
// sits in a Map key in plaintext.
function connectionKey(server: RemoteServerConfig): string {
  const headerPairs = Object.entries(server.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const headerHash = createHash('sha256').update(JSON.stringify(headerPairs)).digest('hex');
  return `${server.url}#${headerHash}`;
}

export class McpClientPool {
  private clients = new Map<string, PooledClient>();
  private toolsCache = new Map<string, { names: string[]; expiresAt: number }>();

  private async createClient(server: RemoteServerConfig): Promise<PooledClient> {
    const client = new Client({ name: 'alexandria', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
    disableStandaloneSse(transport);
    await client.connect(transport);
    return { client };
  }

  private async getClient(server: RemoteServerConfig): Promise<PooledClient> {
    const key = connectionKey(server);
    const existing = this.clients.get(key);
    if (existing) return existing;
    const created = await this.createClient(server);
    this.clients.set(key, created);
    return created;
  }

  private dropClient(server: RemoteServerConfig): void {
    const key = connectionKey(server);
    const existing = this.clients.get(key);
    if (!existing) return;
    this.clients.delete(key);
    existing.client.close().catch(() => {});
  }

  // Runs `fn` against a pooled client for `server`. On any error that
  // looks like transport trouble (including a failure to (re)connect a
  // fresh client), drops the cached client and retries exactly once
  // against a freshly connected one; a second failure is not retried
  // again and propagates to the caller.
  private async withClient<T>(
    server: RemoteServerConfig,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    try {
      const pooled = await this.getClient(server);
      return await fn(pooled.client);
    } catch (err) {
      if (!isTransportTrouble(err)) throw err;
      this.dropClient(server);
      const fresh = await this.getClient(server);
      return await fn(fresh.client);
    }
  }

  // callTool()'s result type is a union: the ordinary tool-call shape
  // (content[] + optional structuredContent + optional isError) or a
  // task-based toolResult shape (see the SDK's experimental task
  // support, unused here). Narrows explicitly rather than assuming the
  // former.
  private extractCallResult(result: unknown): McpCallResult & { isError: boolean } {
    const r = result as Record<string, unknown>;
    const content: unknown = 'content' in r ? r.content : [];
    const items = Array.isArray(content)
      ? (content as Array<{ type?: string; text?: string; resource?: { text?: string } }>)
      : [];
    // Joined with a blank line: some servers (e.g. jina) return one text
    // content item per hit rather than one item for the whole response,
    // and a blank-line join lets a caller recover the individual items
    // by splitting on blank lines without this pool needing to expose
    // the raw content array itself. An embedded-text resource item (e.g.
    // GitHub's get_file_contents, which returns a one-line text summary
    // plus the actual file content as a `resource` item) contributes its
    // resource.text alongside any plain text items, in content order.
    const textParts: string[] = [];
    for (const item of items) {
      if (item.type === 'text' && typeof item.text === 'string') textParts.push(item.text);
      else if (item.type === 'resource' && typeof item.resource?.text === 'string')
        textParts.push(item.resource.text);
    }
    const text = textParts.join('\n\n');
    const structured = 'structuredContent' in r ? r.structuredContent : undefined;
    const isError = 'isError' in r ? Boolean(r.isError) : false;
    return { text, structured, isError };
  }

  async call(
    server: RemoteServerConfig,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const timeoutMs = server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The registry's withGuards() (registry.ts) sets this up around every
    // search()/read() call; using it here means our own HTTP requests get
    // cancelled the moment the caller's guard timeout or abort fires,
    // same as fetchWithRetry() does for the plain REST/RSS kinds.
    const signal = requestContext.getStore()?.signal;
    // The RPC itself (a successful HTTP round trip that returns a
    // CallToolResult, whether or not the tool reports isError) goes
    // through withClient()'s transport-trouble retry. A tool-level error
    // is thrown below, entirely outside that scope, so it never triggers
    // a reconnect, a retry, or (per kinds/mcp.ts) a fallback.
    const result = await this.withClient(server, (client) =>
      client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs, signal }),
    );
    const { text, structured, isError } = this.extractCallResult(result);
    if (isError) throw new Error(`${TOOL_ERROR_PREFIX} ${text}`);
    return { text, structured };
  }

  async tools(server: RemoteServerConfig): Promise<string[]> {
    const cached = this.toolsCache.get(connectionKey(server));
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.names;
    const names = await this.withClient(server, async (client) => {
      const result = await client.listTools();
      return result.tools.map((t) => t.name).sort();
    });
    this.toolsCache.set(connectionKey(server), { names, expiresAt: now + TOOLS_CACHE_MS });
    return names;
  }
}

export const pool = new McpClientPool();
