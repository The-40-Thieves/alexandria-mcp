// A small pool of MCP clients, one per remote server, reused across calls
// (a fresh Client per request would mean a fresh initialize handshake and
// SSE dial every time). Used by src/sources/kinds/mcp.ts's
// defineMcpSource() to delegate a source's search()/read() to a remote
// MCP server's tools/call.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requestContext } from './http.js';

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
function isTransportTrouble(err: unknown): boolean {
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
  return /\b4\d\d\b|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|session|not found|timeout|timed out/i.test(
    haystack,
  );
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
    const existing = this.clients.get(server.name);
    if (existing) return existing;
    const created = await this.createClient(server);
    this.clients.set(server.name, created);
    return created;
  }

  private dropClient(name: string): void {
    const existing = this.clients.get(name);
    if (!existing) return;
    this.clients.delete(name);
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
      this.dropClient(server.name);
      const fresh = await this.getClient(server);
      return await fn(fresh.client);
    }
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
    return this.withClient(server, async (client) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: timeoutMs,
        signal,
      });
      // callTool()'s result type is a union: the ordinary tool-call shape
      // (content[] + optional structuredContent) or a task-based
      // toolResult shape (see the SDK's experimental task support, unused
      // here). Narrow explicitly rather than assuming the former.
      const content: unknown = 'content' in result ? result.content : [];
      const items = Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>)
        : [];
      const text = items
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const structured = 'structuredContent' in result ? result.structuredContent : undefined;
      return { text, structured };
    });
  }

  async tools(server: RemoteServerConfig): Promise<string[]> {
    const cached = this.toolsCache.get(server.name);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.names;
    const names = await this.withClient(server, async (client) => {
      const result = await client.listTools();
      return result.tools.map((t) => t.name).sort();
    });
    this.toolsCache.set(server.name, { names, expiresAt: now + TOOLS_CACHE_MS });
    return names;
  }
}

export const pool = new McpClientPool();
