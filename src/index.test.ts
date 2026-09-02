import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHttpApp, createServer } from './index.ts';

/**
 * Regression test for the shared-McpServer bug: a module-level McpServer that
 * every HTTP request connected to made SDK 1.30's Protocol.connect throw
 * "Already connected to a transport" as soon as two requests overlapped, and
 * Express answered with an HTML 500 carrying a stack trace.
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

test('createServer returns a fresh instance each call', () => {
  const a = createServer();
  const b = createServer();
  assert.notEqual(a, b);
});
