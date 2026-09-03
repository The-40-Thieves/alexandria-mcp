import assert from 'node:assert/strict';
import { type AddressInfo, connect as netConnect } from 'node:net';
import test from 'node:test';
import { createHttpApp, createServer } from './index.ts';
import { resetMetricsForTests } from './utils/metrics.ts';

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
      assert.ok(res.contentType?.includes('application/json'), `not JSON: ${res.contentType}`);
      assert.ok(!res.body.includes('<!DOCTYPE html>'), 'HTML error page leaked');
      const parsed = JSON.parse(res.body) as { result?: { tools?: unknown[] }; error?: unknown };
      assert.equal(parsed.error, undefined);
      assert.equal(parsed.result?.tools?.length, 9);
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
      assert.equal(body.tools, 9);
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
 * Final wave, A10: readJsonBody() used to just throw on an oversized body,
 * leaving the request stream (and its socket) open to keep receiving
 * whatever the client still had queued up to its declared Content-Length.
 * It now destroys the request as soon as the cap is crossed - well before
 * this raw socket has sent anywhere near the (much larger) declared
 * length - so the connection closes instead of the server continuing to
 * read.
 */
test('an oversized POST body gets the 500 envelope and the server closes the connection', async (t) => {
  const app = createHttpApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const oversizedChunk = 'x'.repeat(150 * 1024); // already over the 100kb cap alone
  const declaredLength = 10 * 1024 * 1024; // far more than what's actually sent

  const result = await new Promise<{ data: string; closed: boolean }>((resolve) => {
    let data = '';
    let closed = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ data, closed });
    }, 3000);
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${declaredLength}\r\nConnection: close\r\n\r\n`,
      );
      socket.write(oversizedChunk); // never writes the rest of the declared length
    });
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('close', () => {
      closed = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ data, closed });
    });
    socket.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ data, closed });
    });
  });

  assert.ok(
    result.closed,
    'the server closed the connection instead of waiting for the rest of the declared Content-Length',
  );
  assert.match(result.data, /"code":-32603/, result.data);
});

test('createServer returns a fresh instance each call', () => {
  const a = createServer();
  const b = createServer();
  assert.notEqual(a, b);
});
