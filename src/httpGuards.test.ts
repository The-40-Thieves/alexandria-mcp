import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { checkRateLimit, resetRateLimitForTests } from './httpGuards.ts';
import { createHttpApp } from './index.ts';

function withApp(): { server: Server; port: number; close: () => Promise<void> } {
  const app = createHttpApp();
  const server = app.listen(0);
  return {
    server,
    // Populated once 'listening' fires - callers await start() first.
    get port(): number {
      return (server.address() as AddressInfo).port;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function start(app: { server: Server }): Promise<void> {
  await new Promise<void>((resolve) => app.server.once('listening', resolve));
}

const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

test('origin guard', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('an Origin header naming a disallowed hostname gets a 403', async () => {
    process.env.ALEXANDRIA_ALLOWED_ORIGINS = 'example.com';
    resetRateLimitForTests();
    const app = withApp();
    await start(app);
    t.after(() => app.close());

    const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, origin: 'https://evil.example.net' },
      body: mcpBody,
    });
    assert.equal(res.status, 403);
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
  });

  await t.test('an Origin header naming an allowed hostname reaches the handler', async () => {
    process.env.ALEXANDRIA_ALLOWED_ORIGINS = 'example.com';
    resetRateLimitForTests();
    const app = withApp();
    await start(app);
    t.after(() => app.close());

    const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, origin: 'https://example.com' },
      body: mcpBody,
    });
    assert.equal(res.status, 200);
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
  });

  await t.test('loopback is always allowed even with an unrelated allowlist set', async () => {
    process.env.ALEXANDRIA_ALLOWED_ORIGINS = 'example.com';
    resetRateLimitForTests();
    const app = withApp();
    await start(app);
    t.after(() => app.close());

    const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: mcpBody,
    });
    assert.equal(res.status, 200);
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
  });
});

// Fake req/res for driving checkRateLimit() directly, bypassing an actual
// HTTP round trip: a real /mcp request costs tens of ms (a fresh McpServer
// + transport per call), so 61 of them in a loop take long enough in wall
// time for the bucket's continuous refill (see httpGuards.ts) to add a
// fraction of a token back before the loop finishes - letting extra
// requests through and making the test flaky on a loaded box, not because
// the limiter is wrong. Calling the guard function directly keeps 61
// iterations at native JS speed (microseconds), well under the refill
// window, so the boundary is exact.
function fakeReqRes(remoteAddress: string): {
  req: IncomingMessage;
  res: ServerResponse;
  written: { status?: number; body?: string };
} {
  const written: { status?: number; body?: string } = {};
  const req = { socket: { remoteAddress } } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number) {
      written.status = status;
      return res;
    },
    end(body?: string) {
      written.body = body;
    },
  } as unknown as ServerResponse;
  return { req, res, written };
}

test('checkRateLimit: the 61st call in a burst from one client is rejected with 429', () => {
  resetRateLimitForTests();
  const remoteAddress = '198.51.100.7';
  let rejectedAt = -1;
  let rejection: { status?: number; body?: string } | undefined;

  for (let i = 1; i <= 61; i++) {
    const { req, res, written } = fakeReqRes(remoteAddress);
    const ok = checkRateLimit(req, res);
    if (!ok) {
      rejectedAt = i;
      rejection = written;
      break;
    }
    assert.equal(written.status, undefined, `call ${i} should not have written a response`);
  }

  assert.equal(rejectedAt, 61, 'the 61st call should be the first one rejected');
  assert.equal(rejection?.status, 429);
  const body = JSON.parse(rejection?.body ?? '{}') as {
    jsonrpc?: string;
    error?: { code?: number };
  };
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(typeof body.error?.code, 'number');
});

test('checkRateLimit: a fresh client IP gets its own, unaffected bucket', () => {
  resetRateLimitForTests();
  // Exhaust one client's bucket...
  for (let i = 0; i < 60; i++) {
    const { req, res } = fakeReqRes('198.51.100.8');
    assert.equal(checkRateLimit(req, res), true);
  }
  const { req: exhaustedReq, res: exhaustedRes } = fakeReqRes('198.51.100.8');
  assert.equal(checkRateLimit(exhaustedReq, exhaustedRes), false);

  // ...a different client is untouched.
  const { req: freshReq, res: freshRes } = fakeReqRes('198.51.100.9');
  assert.equal(checkRateLimit(freshReq, freshRes), true);
});

test('rate limit wiring: an actual /mcp request over a small configured limit gets 429', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });
  process.env.ALEXANDRIA_HTTP_RATE_LIMIT = '2';
  resetRateLimitForTests();
  t.after(() => resetRateLimitForTests());

  const app = withApp();
  await start(app);
  t.after(() => app.close());

  const post = () =>
    fetch(`http://127.0.0.1:${app.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: mcpBody,
    });

  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const third = await post();
  assert.equal(third.status, 429);
  const body = (await third.json()) as { jsonrpc?: string; error?: { code?: number } };
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(typeof body.error?.code, 'number');
});
