// Shared in-process MCP server fixture for tests: McpServer +
// StreamableHTTPServerTransport on an ephemeral port via Express, exactly
// as src/index.ts's own HTTP transport (stateless: a fresh transport per
// request), exposing a fake `search`/`read` tool pair whose behavior each
// test controls. Not itself a *.test.ts file, so the test runner glob
// skips it; mcpClientPool.test.ts and sources/kinds/mcp.test.ts both
// import it so they exercise the pool and the mcp kind against a real (if
// fake) MCP server instead of a mocked fetch.
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';

export type TestContentItem =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } };

export interface TestToolResult {
  [key: string]: unknown;
  content: TestContentItem[];
  structuredContent?: Record<string, unknown>;
}

export interface TestMcpServerOptions {
  // Bind to this exact port instead of an ephemeral one. Used to
  // "recreate" a server on the same address after closing a previous
  // handle, simulating a restart from a client's point of view.
  port?: number;
  // When set, the Nth request (1-indexed, across the lifetime of this
  // server instance) fails with an HTTP error instead of being handled,
  // simulating transport trouble against an otherwise-working server. A
  // test that wants to simulate "the server was killed and a fresh one
  // took its place" closes this handle and calls startTestMcpServer()
  // again for the replacement, rather than reusing the count.
  failRequest?: number;
  // When true, every request fails with an HTTP error (a server that
  // never recovers), unlike failRequest's one-shot failure.
  failAlways?: boolean;
  failStatus?: number; // default 400
  search?: (args: Record<string, unknown>) => TestToolResult;
  read?: (args: Record<string, unknown>) => TestToolResult;
}

export interface TestMcpServerHandle {
  url: string;
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
}

function defaultResult(label: string, args: Record<string, unknown>): TestToolResult {
  return {
    content: [{ type: 'text', text: `no ${label} handler configured for ${JSON.stringify(args)}` }],
  };
}

export async function startTestMcpServer(
  opts: TestMcpServerOptions = {},
): Promise<TestMcpServerHandle> {
  const server = new McpServer({ name: 'test-mcp', version: '1.0.0' });

  server.registerTool(
    'search',
    {
      description: 'fake search',
      inputSchema: { query: z.string(), limit: z.number().optional() },
    },
    async (args) => (opts.search ? opts.search(args) : defaultResult('search', args)),
  );
  server.registerTool(
    'read',
    { description: 'fake read', inputSchema: { id: z.string() } },
    async (args) => (opts.read ? opts.read(args) : defaultResult('read', args)),
  );

  let count = 0;
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    count++;
    if (opts.failAlways || (opts.failRequest && count === opts.failRequest)) {
      res.status(opts.failStatus ?? 400).json({ error: 'simulated transport trouble' });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer: Server = app.listen(opts.port ?? 0);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    requestCount: () => count,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
