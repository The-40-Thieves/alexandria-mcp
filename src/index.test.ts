import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type AddressInfo, connect as netConnect } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { createHttpApp, createServer, progressReporter } from './index.ts';
import { register } from './sources/registry.ts';
import { TOOL_COUNT } from './toolCount.ts';
import { resetMetricsForTests } from './utils/metrics.ts';
import { dnsResolver } from './web/fetchTier.ts';

// Writes a raw, hand-built HTTP/1.1 request line straight to a socket
// (bypassing fetch/undici, which would themselves reject an invalid
// request-target before anything reached the wire) and resolves with
// whatever bytes come back, or '' if nothing arrives before timeoutMs.
// Used to reproduce a request-line target the WHATWG URL parser rejects
// but Node's own, more lenient HTTP parser accepts and hands straight
// through as `req.url`.
function rawRequest(port: number, requestLine: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(requestLine));
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(data);
    };
    socket.on('data', (chunk) => {
      data += chunk.toString();
      finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
    // Final wave, B6: finish() used to leave this timer running even after
    // an earlier trigger (data/error/close) already settled - harmless
    // (the `settled` guard no-ops the late fire) but it kept a handle open
    // for the rest of timeoutMs regardless. clearTimeout in finish() above
    // stops that on the common early-settle path; unref() covers the
    // remaining case (this timer itself is the one that fires) by never
    // holding the process/test runner open on its own account.
    const timer = setTimeout(finish, timeoutMs).unref();
  });
}

// Task 14: the dual-era handler's built-in 2025-era fallback
// (`createMcpHandler`'s `legacy: 'stateless'`) always answers a POST over
// its own `WebStandardStreamableHTTPServerTransport`, which streams
// `text/event-stream` by default - unlike the hand-wired
// `NodeStreamableHTTPServerTransport({ enableJsonResponse: true })` this
// replaces, createMcpHandler exposes no equivalent knob for the legacy path
// (see support-2026-07-28.md; `responseMode` only shapes 2026-07-28
// exchanges). A single-request SSE response is exactly one
// `event: message\ndata: <json>\n\n` frame, so parsing it is just picking
// the one `data:` line back out; every /mcp call below (still a single,
// non-streaming JSON-RPC request) goes through this instead of `res.json()`.
interface McpRpcBody {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

function parseMcpText(contentType: string | null, body: string): McpRpcBody {
  if (!contentType?.includes('text/event-stream')) return JSON.parse(body);
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`no SSE data line in response: ${body.slice(0, 200)}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

async function parseMcpResponse(res: Response): Promise<McpRpcBody> {
  return parseMcpText(res.headers.get('content-type'), await res.text());
}

/**
 * Regression test for the shared-McpServer bug: a module-level McpServer that
 * every HTTP request connected to made Protocol.connect reject a second
 * transport attaching to a server that already has one as soon as two
 * requests overlapped. The malformed-body case guards the same "never leak
 * HTML or a stack trace" property src/index.ts's plain node:http listener
 * is responsible for now that Express is gone.
 */
test('HTTP transport handles concurrent requests', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await t.test('six concurrent tools/list requests all return valid JSON', async () => {
    const post = async (id: number) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
      });
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: await res.text(),
      };
    };

    const responses = await Promise.all([1, 2, 3, 4, 5, 6].map(post));

    assert.equal(responses.length, 6);
    for (const res of responses) {
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body.slice(0, 200)}`);
      // Task 14: the dual-era handler's legacy fallback answers over SSE by
      // default (see parseMcpText's comment) - either content-type is a
      // valid, non-HTML response.
      assert.ok(
        res.contentType?.includes('application/json') ||
          res.contentType?.includes('text/event-stream'),
        `not JSON or SSE: ${res.contentType}`,
      );
      assert.ok(!res.body.includes('<!DOCTYPE html>'), 'HTML error page leaked');
      const parsed = parseMcpText(res.contentType, res.body) as {
        result?: { tools?: unknown[] };
        error?: unknown;
      };
      assert.equal(parsed.error, undefined);
      assert.equal(parsed.result?.tools?.length, TOOL_COUNT);
    }
  });

  await t.test('a malformed body returns a JSON-RPC error, never HTML or a stack', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const body = await res.text();
    assert.ok(!body.includes('<!DOCTYPE html>'), 'HTML error page leaked');
    assert.ok(!body.includes('    at '), 'stack trace leaked');
    const parsed = JSON.parse(body) as { jsonrpc?: string; error?: { code?: number } };
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.error?.code, -32603);
  });
});

/**
 * Regression test: `new URL(req.url, base)` throws synchronously on a
 * request-target the WHATWG URL parser rejects but Node's own, more
 * lenient HTTP request-line parser accepts and hands straight through as
 * `req.url` - a synchronous throw in a plain node:http request listener is
 * an uncaught exception that exits the whole process on one unauthenticated
 * request. `requestPath()` in src/index.ts never parses a URL at all (a
 * plain string split), so none of these can reach that code path.
 */
test('a request-target the WHATWG URL parser would reject does not crash the process', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const targets = [
    'GET //[ HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET http://%/ HTTP/1.1\r\nHost: x\r\n\r\n',
  ];

  for (const requestLine of targets) {
    await t.test(`answers instead of crashing on ${JSON.stringify(requestLine)}`, async () => {
      const response = await rawRequest(port, requestLine);
      assert.ok(
        response.startsWith('HTTP/1.1'),
        `no HTTP response at all: ${response.slice(0, 200)}`,
      );
    });
  }

  await t.test('the process is still up and answering after all three', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  });
});

test('/mcp tolerates a trailing slash and mixed case, like the old Express defaults', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  await t.test('/mcp/ (trailing slash) reaches the handler', async () => {
    const res = await post('/mcp/');
    assert.equal(res.status, 200);
  });

  await t.test('/MCP (uppercase) reaches the handler', async () => {
    const res = await post('/MCP');
    assert.equal(res.status, 200);
  });
});

test('unknown paths and non-GET on /health or /metrics both 404', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await t.test('an unrouted path 404s', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  });

  await t.test(
    'POST /health 404s (no POST route registered, same as the old Express app)',
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
      assert.equal(res.status, 404);
    },
  );

  await t.test('POST /metrics 404s', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

/**
 * Regression test: `hasJsonContentType()`'s case-sensitive
 * `includes('application/json')` let a header like `Application/JSON` skip
 * the 100kb body cap entirely, reaching the SDK's own unbounded
 * `await req.json()`. Both a lowercase and a mixed-case content-type must
 * hit the same cap and answer with the same JSON-RPC error envelope.
 */
test('a body over the 100kb JSON cap is rejected regardless of content-type casing', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const oversizedBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { padding: 'x'.repeat(150 * 1024) },
  });

  for (const contentType of ['application/json', 'Application/JSON']) {
    await t.test(`content-type: ${contentType}`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: oversizedBody,
      });
      const body = await res.text();
      const parsed = JSON.parse(body) as {
        jsonrpc?: string;
        error?: { code?: number };
        id?: unknown;
      };
      assert.equal(parsed.jsonrpc, '2.0');
      assert.equal(parsed.error?.code, -32603);
      assert.equal(parsed.id, null);
    });
  }
});

/**
 * Regression test: the try/catch inside handleMcpRequest only ever covered
 * /mcp. A throw from healthSummary()/sourceCallTotals()/metricsSnapshot()
 * or from JSON.stringify while building /health or /metrics's response body
 * was an uncaught synchronous exception in the plain node:http listener -
 * fatal to the whole process, not just that one request.
 */
test('a throw while building /health or /metrics is caught, not fatal', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await t.test('/health', async (subtest) => {
    // Only the /health response body itself (a plain object shaped like
    // `{ status: 'ok', ..., tools: N }`) throws - undici's own client-side
    // JSON.stringify calls (cloning Pool/Agent options on the way OUT to
    // fetch() below) are left alone, or the client request never reaches
    // the server at all.
    const original = JSON.stringify;
    subtest.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
      const [value] = args;
      if (
        value !== null &&
        typeof value === 'object' &&
        (value as { status?: unknown }).status === 'ok' &&
        'tools' in value
      ) {
        throw new Error('stringify boom');
      }
      return original(...args);
    });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.text();
    const parsed = JSON.parse(body) as {
      jsonrpc?: string;
      error?: { code?: number };
      id?: unknown;
    };
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.error?.code, -32603);
    assert.equal(parsed.id, null);
  });

  await t.test('the process survived and /metrics still answers normally', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
  });
});

test('GET /health and GET /metrics', async (t) => {
  resetMetricsForTests();
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await t.test(
    '/health nests calls/errors under sources, alongside total/visible/hidden',
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        sources: { total: number; visible: number; hidden: number; calls: number; errors: number };
        tools: number;
      };
      assert.equal(body.status, 'ok');
      assert.ok(body.sources.total > 0);
      assert.equal(typeof body.sources.calls, 'number');
      assert.equal(typeof body.sources.errors, 'number');
      assert.equal(body.tools, TOOL_COUNT);
    },
  );

  await t.test('/metrics starts as empty sources/tools maps', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sources: Record<string, unknown>;
      tools: Record<string, unknown>;
    };
    assert.deepEqual(body, { sources: {}, tools: {} });
  });

  await t.test(
    "a tools/call bumps that tool's invocations counter, visible on /metrics",
    async () => {
      const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'library_list_sources', arguments: {} },
        }),
      });
      assert.equal(call.status, 200);

      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      const body = (await res.json()) as { tools: Record<string, { invocations: number }> };
      assert.equal(body.tools.library_list_sources?.invocations, 1);
    },
  );
});

/**
 * Final wave, A10: the old Express app answered HEAD on a GET route with
 * headers and no body by default; the plain node:http listener only ever
 * matched GET, so a HEAD /health or HEAD /metrics 404'd. sendJson() now
 * writes the same headers (content-type, content-length) either way and
 * only omits the body for HEAD.
 */
test('HEAD /health and HEAD /metrics answer with headers and no body', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  for (const path of ['/health', '/metrics']) {
    await t.test(path, async () => {
      const [getRes, headRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}${path}`),
        fetch(`http://127.0.0.1:${port}${path}`, { method: 'HEAD' }),
      ]);
      const getBody = await getRes.text();
      const headBody = await headRes.text();

      assert.equal(headRes.status, 200);
      assert.equal(headRes.headers.get('content-type'), 'application/json');
      assert.equal(
        headRes.headers.get('content-length'),
        getRes.headers.get('content-length'),
        'HEAD reports the same content-length a GET would have sent',
      );
      assert.equal(headBody, '', 'HEAD carries no body');
      assert.ok(getBody.length > 0, 'sanity: the GET response does have a body');
    });
  }
});

/**
 * Final wave, A10 (review round 2): readJsonBody() used to just throw on
 * an oversized body, leaving the request stream (and its socket) open to
 * keep receiving whatever the client still had queued up to its declared
 * Content-Length. The first attempt at a fix (destroying `req` from
 * inside the catch block) looked right and even passed a test - but the
 * test's request line declared `Connection: close`, so Node's own HTTP
 * server closes the socket after responding regardless of whether the
 * fix does anything at all, and the fix itself was a no-op: by the time
 * readJsonBody()'s `for await` throws, Node's async-iterator protocol has
 * already destroyed `req`'s readable side as part of unwinding the loop
 * (so `req.destroyed` is already true and `req.socket` already
 * detached), so `if (!req.destroyed) req.destroy()` never runs, and even
 * unguarded would have nothing left to close. This request line does NOT
 * declare Connection: close, so an early close here can only be the
 * server's own action (handleMcpRequest's captured `sock` +
 * `res.on('finish', () => sock?.destroy())`), and the promise below has
 * no soft "closed: true" fallback on timeout - if the server does not
 * close the connection, this test fails instead of quietly passing.
 */
test('an oversized POST body gets the 500 envelope and the server closes the connection', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const oversizedChunk = 'x'.repeat(150 * 1024); // already over the 100kb cap alone
  const declaredLength = 10 * 1024 * 1024; // far more than what's actually sent

  const socket = netConnect(port, '127.0.0.1');
  t.after(() => {
    if (!socket.destroyed) socket.destroy();
  });
  await new Promise<void>((resolve) => socket.once('connect', resolve));

  let data = '';
  socket.on('data', (chunk) => {
    data += chunk.toString();
  });

  // Deliberately NOT `Connection: close` - see the comment above for why
  // that would make this test pass regardless of whether the production
  // fix does anything.
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${declaredLength}\r\n\r\n`,
  );
  socket.write(oversizedChunk); // never writes the rest of the declared length

  // No soft fallback: 'close', 'end', and 'error' all count as the
  // connection being torn down; a plain timeout is a hard test failure
  // (an unhandled rejection / the awaited promise never settling), not a
  // silently-accepted "the server left it open".
  await Promise.race([
    new Promise<void>((resolve) => socket.once('close', () => resolve())),
    new Promise<void>((resolve) => socket.once('end', () => resolve())),
    new Promise<void>((resolve) => socket.once('error', () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('the server did not close the connection within 2000ms')),
        2000,
      ),
    ),
  ]);

  assert.match(data, /"code":-32603/, data);

  // No further bytes accepted: the socket must already be torn down, not
  // merely half-closed and still willing to read more of the declared
  // Content-Length.
  assert.ok(
    socket.destroyed || socket.readyState === 'closed',
    `expected the socket to be destroyed/closed, got readyState=${socket.readyState}`,
  );
});

test('createServer returns a fresh instance each call', () => {
  const a = createServer();
  const b = createServer();
  assert.notEqual(a, b);
});

/**
 * Task 1 (agent ergonomics): every tool advertises `title`, `annotations`,
 * and `outputSchema` in `tools/list`, and `initialize` carries the
 * server-wide `instructions` string. A client can't rely on any of these
 * MAY-level fields silently regressing back to undefined.
 */
test('tools/list carries title/annotations/outputSchema for all 11 tools; initialize carries instructions', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rpc = async (method: string, params: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await parseMcpResponse(res)) as { result?: Record<string, unknown> };
  };

  await t.test('tools/list', async () => {
    const { result } = await rpc('tools/list', {});
    const tools = result?.tools as Array<Record<string, unknown>> | undefined;
    assert.equal(tools?.length, TOOL_COUNT);
    for (const tool of tools ?? []) {
      assert.ok(typeof tool.title === 'string' && tool.title.length > 0, `${tool.name}: no title`);
      assert.ok(
        tool.annotations && typeof tool.annotations === 'object',
        `${tool.name}: no annotations`,
      );
      assert.ok(
        tool.outputSchema && typeof tool.outputSchema === 'object',
        `${tool.name}: no outputSchema`,
      );
    }
  });

  await t.test('initialize', async () => {
    const { result } = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.ok(
      typeof result?.instructions === 'string' && (result.instructions as string).length > 0,
    );
  });
});

/**
 * A structured-content-against-schema regression for library_search: the
 * SDK validates `structuredContent` against the tool's advertised
 * `outputSchema` on every call (see registerTool's outputSchema doc and
 * ajvProvider), so a shape drift between format.ts's concise row and
 * index.ts's ResultRowSchema fails HERE, as an `isError` tool result, not
 * silently at some client months later. Both response_format values are
 * exercised against the same stubbed adapter.
 */
test('library_search structuredContent validates against outputSchema, concise and detailed', async (t) => {
  register('t_index_schema_fixture', {
    description: 'fixture source for the outputSchema regression test',
    supportsIngest: false,
    async search() {
      return [
        {
          id: 'x1',
          source: 't_index_schema_fixture',
          title: 'Fixture Item',
          authors: ['A. Author'],
          year: 2020,
          hasFullText: true,
          url: 'https://example.org/x1',
          description: 'a fixture description',
        },
      ];
    },
    async read() {
      return { title: 'x', authors: [] };
    },
  });

  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'library_search', arguments: args },
      }),
    });
    return (await parseMcpResponse(res)) as {
      result?: {
        isError?: boolean;
        structuredContent?: { results: Array<Record<string, unknown>> };
      };
    };
  };

  await t.test(
    'concise (default): rows drop authors/description, keep the wrapper shape',
    async () => {
      const { result } = await call({ query: 'x', source: 't_index_schema_fixture' });
      assert.equal(
        result?.isError,
        undefined,
        'the concise payload must validate against outputSchema',
      );
      const row = result?.structuredContent?.results[0];
      assert.deepEqual(row, {
        title: 'Fixture Item',
        source: 't_index_schema_fixture',
        id: 'x1',
        hasFullText: true,
        year: 2020,
        url: 'https://example.org/x1',
      });
    },
  );

  await t.test('detailed: rows keep authors/description', async () => {
    const { result } = await call({
      query: 'x',
      source: 't_index_schema_fixture',
      response_format: 'detailed',
    });
    assert.equal(
      result?.isError,
      undefined,
      'the detailed payload must validate against outputSchema',
    );
    const row = result?.structuredContent?.results[0];
    assert.equal((row?.authors as string[] | undefined)?.[0], 'A. Author');
    assert.equal(row?.description, 'a fixture description');
  });
});

/**
 * Same regression as library_search's, above, for library_citations: its
 * outputSchema (seed/direction/results/formatted) must validate against
 * what libraryCitations() actually returns, on both response_format
 * values. Routed through the OpenCitations fallback path (a stubbed
 * global fetch: OpenAlex 404s, OpenCitations answers) rather than a real
 * OpenAlex call, since libraryCitations.ts fetches OpenAlex directly
 * (not through a registered, mockable adapter).
 */
test('library_citations structuredContent validates against outputSchema, concise and detailed', async (t) => {
  register('t_citations_schema_fixture', {
    description: 'fixture source for the outputSchema regression test',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], doi: '10.9999/fixture-schema' };
    },
  });

  // Only OpenAlex/OpenCitations calls (libraryCitations.ts fetches both
  // directly, not through a registered adapter) are stubbed; anything else
  // - notably this test's own `call()` below, hitting the local /mcp server
  // - passes through to the real fetch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('api.openalex.org')) {
      return new Response('not found', { status: 404 });
    }
    if (u.includes('api.opencitations.net/index/v2/citations/doi:10.9999/fixture-schema')) {
      return new Response(
        JSON.stringify([
          {
            oci: 'a-b',
            citing: 'doi:10.5555/citer',
            cited: 'doi:10.9999/fixture-schema',
            creation: '2021-01-01',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'library_citations', arguments: args },
      }),
    });
    return (await parseMcpResponse(res)) as {
      result?: {
        isError?: boolean;
        structuredContent?: {
          seed: Record<string, unknown>;
          direction: string;
          results: Array<Record<string, unknown>>;
        };
      };
    };
  };

  await t.test('concise (default): validates and drops previewUrl from rows', async () => {
    const { result } = await call({
      id: 'x1',
      source: 't_citations_schema_fixture',
      direction: 'citations',
    });
    assert.equal(
      result?.isError,
      undefined,
      'the concise payload must validate against outputSchema',
    );
    assert.equal(result?.structuredContent?.seed.doi, '10.9999/fixture-schema');
    assert.equal(result?.structuredContent?.direction, 'citations');
    const row = result?.structuredContent?.results[0];
    assert.equal(row?.id, '10.5555/citer');
    assert.equal(row?.source, 'opencitations');
    assert.equal('previewUrl' in (row ?? {}), false);
  });

  await t.test('detailed: rows keep previewUrl', async () => {
    const { result } = await call({
      id: 'x1',
      source: 't_citations_schema_fixture',
      direction: 'citations',
      response_format: 'detailed',
    });
    assert.equal(
      result?.isError,
      undefined,
      'the detailed payload must validate against outputSchema',
    );
    assert.equal(
      result?.structuredContent?.results[0]?.previewUrl,
      'https://doi.org/10.5555/citer',
    );
  });
});

test('library_ingest and library_index honor the source ingestPolicy', async (t) => {
  const LONG_TEXT =
    'The quick brown fox jumps over the lazy dog near the riverbank every single morning ' +
    'before the sun has fully risen above the eastern hills, and the villagers who wake ' +
    'early enough to see it always remark on how gracefully it moves through the tall grass.';

  register('t_ingest_forbidden', {
    description: 'fixture source with a forbidden ingest policy',
    supportsIngest: true,
    ingestPolicy: 'forbidden',
    async search() {
      return [];
    },
    async read() {
      throw new Error('read() must never be called: assertIngestAllowed should refuse first');
    },
  });

  register('t_index_attribution', {
    description: 'fixture source with an attribution ingest policy',
    supportsIngest: true,
    ingestPolicy: 'attribution',
    homepage: 'https://example.org/attribution-source',
    async search() {
      return [];
    },
    async read() {
      return { title: 'Fixture Title', authors: ['A. Author'], text: LONG_TEXT };
    },
  });

  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return (await parseMcpResponse(res)) as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
  };

  await t.test('library_ingest refuses a forbidden source before calling read()', async () => {
    const { result } = await call('library_ingest', { id: 'x1', source: 't_ingest_forbidden' });
    assert.equal(result?.isError, true);
    assert.match(result?.content?.[0]?.text ?? '', /"t_ingest_forbidden" cannot be ingested/);
  });

  await t.test('library_index reports the source ingestPolicy in its preview', async () => {
    const { result } = await call('library_index', { id: 'x1', source: 't_index_attribution' });
    assert.equal(result?.isError, undefined);
    assert.equal(result?.structuredContent?.ingestPolicy, 'attribution');
  });
});

// Task 6: library_read's open-access fallback chain. Both fixture adapters
// return metadataOnly: true with a DOI; the network is fully mocked
// (openalex/idconv/fatcat responses, plus the PDF itself) rather than
// fetched, per the brief's test constraints.
test('library_read open-access fallback', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  delete process.env.CORE_API_KEY;
  // openalex/oa.example.org aren't real hosts under test - stub the
  // resolver so assertFetchableUrl's guard sees an ordinary public address
  // for them instead of a real DNS lookup.
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) as typeof dnsResolver.lookup;

  const samplePdfBytes = readFileSync(path.resolve(process.cwd(), 'eval/fixtures/sample.pdf'));

  register('t_read_oa_pdf', {
    description: 'fixture: metadataOnly with a DOI that resolves to a PDF via openalex',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return {
        title: 'Fixture Paper',
        authors: ['A. Author'],
        metadataOnly: true,
        doi: '10.9999/pdf-fixture',
      };
    },
  });

  register('t_read_oa_unavailable', {
    description: 'fixture: metadataOnly with a DOI that no open-access hop can resolve',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return {
        title: 'Unreachable Paper',
        authors: ['B. Author'],
        metadataOnly: true,
        externalUrl: 'https://doi.org/10.9999/missing-fixture',
      };
    },
  });

  register('t_read_short_text_no_doi', {
    description:
      'fixture: short text (no metadataOnly) but no DOI at all - never triggers the fallback',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return {
        title: 'Short But Undoi-ed',
        authors: ['C. Author'],
        text: 'A short stub with no DOI anywhere.',
      };
    },
  });

  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await originalFetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return (await parseMcpResponse(res)) as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
  };

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    // crossref itself: a short abstract (well under MIN_FULL_TEXT_CHARS),
    // no references, so the fallback triggers on short text rather than
    // metadataOnly - this is the review round 1 Important-1 path.
    if (url.includes('api.crossref.org/works/')) {
      return new Response(
        JSON.stringify({
          message: {
            DOI: '10.9999/crossref-fixture',
            title: ['A Crossref Fixture Work'],
            author: [{ given: 'A', family: 'Author' }],
            abstract: '<jats:p>A short abstract, well under the full-text threshold.</jats:p>',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith('https://doi.org/10.9999/crossref-fixture')) {
      return new Response('bibtex unavailable', { status: 500 }); // optional; crossrefRead tolerates this
    }
    if (url.includes('api.openalex.org')) {
      if (url.includes('pdf-fixture') || url.includes('crossref-fixture')) {
        return new Response(
          JSON.stringify({ best_oa_location: { pdf_url: 'https://oa.example.org/paper.pdf' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://oa.example.org/paper.pdf') {
      return new Response(new Uint8Array(samplePdfBytes), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    if (url.includes('idconv')) {
      return new Response(JSON.stringify({ records: [{}] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('api.fatcat.wiki')) {
      return new Response('not found', { status: 404 });
    }
    return originalFetch(input as string, init);
  }) as typeof fetch;

  await t.test(
    'resolves via openalex to a PDF: metadataOnly flips false, pages are set',
    async () => {
      const { result } = await call('library_read', { id: 'x1', source: 't_read_oa_pdf' });
      assert.equal(result?.isError, undefined);
      const structured = result?.structuredContent;
      assert.equal(structured?.metadataOnly, false);
      assert.equal(
        structured?.text,
        'Hello from page one of the fixture PDF.\n\nHello from page two of the fixture PDF.',
      );
      assert.deepEqual(structured?.pages, [
        { page: 1, charStart: 0, charEnd: 39 },
        { page: 2, charStart: 41, charEnd: 80 },
      ]);
      assert.equal(structured?.unavailable, undefined);
    },
  );

  await t.test('reports unavailable with the tiers tried when every OA hop fails', async () => {
    const { result } = await call('library_read', { id: 'x2', source: 't_read_oa_unavailable' });
    assert.equal(result?.isError, undefined);
    const structured = result?.structuredContent;
    assert.equal(structured?.text, undefined);
    assert.deepEqual(structured?.unavailable, {
      reason: 'not_found',
      triedTiers: ['openalex', 'pmc', 'core', 'fatcat'],
    });
    // metadataOnly is untouched (still true) - the fallback never got real text.
    assert.equal(structured?.metadataOnly, true);
  });

  // Review round 1, Important 1: a REAL scholarly adapter (crossref, never
  // metadataOnly) whose read() returns a short abstract plus a DOI must
  // also run the fallback chain, not just a metadataOnly fixture.
  await t.test(
    'a real scholarly adapter (crossref) with a short abstract and a DOI runs the chain and gets PDF text with pages',
    async () => {
      const { result } = await call('library_read', {
        id: '10.9999/crossref-fixture',
        source: 'crossref',
      });
      assert.equal(result?.isError, undefined);
      const structured = result?.structuredContent;
      assert.equal(structured?.metadataOnly, false);
      assert.equal(structured?.doi, '10.9999/crossref-fixture');
      assert.equal(
        structured?.text,
        'Hello from page one of the fixture PDF.\n\nHello from page two of the fixture PDF.',
      );
      assert.deepEqual(structured?.pages, [
        { page: 1, charStart: 0, charEnd: 39 },
        { page: 2, charStart: 41, charEnd: 80 },
      ]);
      // The original abstract is preserved, not discarded.
      assert.match(
        String(structured?.note),
        /A short abstract, well under the full-text threshold\./,
      );
      assert.equal(structured?.unavailable, undefined);
    },
  );

  await t.test('a short-text result with no DOI anywhere never triggers the fallback', async () => {
    const { result } = await call('library_read', { id: 'x3', source: 't_read_short_text_no_doi' });
    assert.equal(result?.isError, undefined);
    const structured = result?.structuredContent;
    assert.equal(structured?.text, 'A short stub with no DOI anywhere.');
    assert.equal(structured?.unavailable, undefined);
  });
});

/**
 * Task 1 review finding 3: a progress/logging notification is best-effort.
 * By the time library_ingest's second `report()` call fires, ingestText()
 * has already durably written its chunks; by the time library_answer's
 * last call fires, the answer has already been synthesised. A throwing
 * `notify` must never turn either into a reported `isError` - this test
 * drives `progressReporter` through the exact try/await-report/catch shape
 * every progress-emitting handler in this file uses, with a `notify` that
 * always rejects, and asserts the "tool" still completes normally.
 */
test('progressReporter swallows a notify failure so it can never turn a successful result into isError', async () => {
  let notifyCalls = 0;
  const ctx = {
    mcpReq: {
      _meta: { progressToken: 'tok-1' },
      notify: async () => {
        notifyCalls++;
        throw new Error('simulated transport failure');
      },
    },
  } as unknown as ServerContext;
  const server = { sendLoggingMessage: async () => undefined } as unknown as McpServer;

  const report = progressReporter(server, ctx);

  let outcome: { ok: true; value: string } | { ok: false };
  try {
    await report(1, 'started; chunking and embedding');
    const value = 'durable work already happened here'; // stands in for ingestText()'s write
    await report(2, 'ingested chunk batch');
    outcome = { ok: true, value };
  } catch {
    outcome = { ok: false };
  }

  assert.deepEqual(outcome, { ok: true, value: 'durable work already happened here' });
  assert.equal(notifyCalls, 2, 'both notify attempts ran (and both failed) before this assertion');
});

/**
 * Task 14 (2026-07-28 dual-era handler, brief 05): `createMcpHandler(factory,
 * { legacy: 'stateless' })` must serve a 2026-07-28 `server/discover` probe
 * and a legacy `initialize` handshake against the same `/mcp` listener, from
 * the same `createServer()` factory.
 */
test('the dual-era handler serves both a 2026-07-28 probe and a legacy handshake', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await t.test('2026-07-28 server/discover succeeds on the modern path', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const parsed = (await parseMcpResponse(res)) as { result?: { supportedVersions?: string[] } };
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(parsed)}`);
    assert.ok(parsed.result?.supportedVersions?.includes('2026-07-28'));
  });

  await t.test('a legacy 2025-11-25 initialize still succeeds on the same endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(res.status, 200);
    const { result } = (await parseMcpResponse(res)) as {
      result?: { protocolVersion?: string };
    };
    assert.equal(result?.protocolVersion, '2025-11-25');
  });
});

/**
 * Task 14: the three canonical research-workflow prompts (literature_review,
 * fact_check_claim, verify_bibliography) are registered and each returns a
 * single user message naming the tools to call, in order.
 */
test('prompts/list returns the three research-workflow prompts', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rpc = async (method: string, params: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return parseMcpResponse(res);
  };

  await t.test('prompts/list', async () => {
    const { result } = await rpc('prompts/list', {});
    const prompts = result?.prompts as Array<{ name: string }> | undefined;
    assert.equal(prompts?.length, 3);
    assert.deepEqual(prompts?.map((p) => p.name).sort(), [
      'fact_check_claim',
      'literature_review',
      'verify_bibliography',
    ]);
  });

  await t.test('literature_review names its tools in order, in a user message', async () => {
    const { result } = await rpc('prompts/get', {
      name: 'literature_review',
      arguments: { topic: 'gut microbiome' },
    });
    const messages = result?.messages as
      | Array<{ role: string; content: { type: string; text: string } }>
      | undefined;
    assert.equal(messages?.length, 1);
    assert.equal(messages?.[0]?.role, 'user');
    const text = messages?.[0]?.content.text ?? '';
    assert.match(text, /gut microbiome/);
    assert.match(text, /library_list_sources/);
    assert.match(text, /library_ask/);
    assert.match(text, /library_research/);
    assert.match(text, /library_citations/);
  });
});

/**
 * Task 14: `library://doc/{source}/{id}` reads through the same adapter
 * `library_read` uses, returning the item's text as the resource content.
 */
test('resources/read on library://doc/{source}/{id} returns text from a stubbed adapter', async (t) => {
  register('t_resource_fixture', {
    description: 'fixture source for the resources/read regression test',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return { title: 'Fixture Document', authors: ['A. Author'], text: 'Full fixture text.' };
    },
  });

  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'library://doc/t_resource_fixture/x1' },
    }),
  });
  const parsed = (await parseMcpResponse(res)) as {
    result?: { contents?: Array<{ uri: string; text?: string; mimeType?: string }> };
  };
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(parsed)}`);
  const { result } = parsed;
  assert.equal(result?.contents?.length, 1);
  assert.equal(result?.contents?.[0]?.text, 'Full fixture text.');
  assert.equal(result?.contents?.[0]?.uri, 'library://doc/t_resource_fixture/x1');
});
