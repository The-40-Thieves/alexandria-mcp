import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  trackedClientCountForTests as buckets,
  checkOrigin,
  checkRateLimit,
  hasTrackedClientForTests,
  MAX_TRACKED_CLIENTS_FOR_TESTS,
  resetRateLimitForTests,
} from './httpGuards.ts';
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
// `localAddress` is the interface the connection arrived on, which is what
// checkOrigin's Host-check condition reads (final wave B1); it defaults to
// loopback so every existing rate-limit caller is unaffected.
function fakeReqRes(
  remoteAddress: string,
  headers: Record<string, string> = {},
  localAddress = '127.0.0.1',
): {
  req: IncomingMessage;
  res: ServerResponse;
  written: { status?: number; body?: string };
} {
  const written: { status?: number; body?: string } = {};
  const req = { socket: { remoteAddress, localAddress }, headers } as unknown as IncomingMessage;
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

// Task 15 (Controller amendment): ALEXANDRIA_TRUSTED_PROXY changes which
// header checkRateLimit's clientKey() reads. Both branches (flag set,
// flag unset) are exercised against the SAME socket address carrying
// different proxy-set headers, so a pass here can only be explained by the
// header actually driving the bucket key, not the socket address.
test('checkRateLimit: ALEXANDRIA_TRUSTED_PROXY', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test(
    'keys on CF-Connecting-IP when the flag is set, not the shared proxy socket address',
    () => {
      process.env.ALEXANDRIA_TRUSTED_PROXY = '1';
      resetRateLimitForTests();
      const proxyAddress = '10.0.0.1'; // the same for every client behind the proxy

      // Exhaust client A's bucket...
      for (let i = 0; i < 60; i++) {
        const { req, res } = fakeReqRes(proxyAddress, { 'cf-connecting-ip': '198.51.100.10' });
        assert.equal(checkRateLimit(req, res), true);
      }
      const { req: aReq, res: aRes } = fakeReqRes(proxyAddress, {
        'cf-connecting-ip': '198.51.100.10',
      });
      assert.equal(checkRateLimit(aReq, aRes), false, 'client A should now be rejected');

      // ...client B, behind the same proxy socket address, is untouched.
      const { req: bReq, res: bRes } = fakeReqRes(proxyAddress, {
        'cf-connecting-ip': '198.51.100.11',
      });
      assert.equal(checkRateLimit(bReq, bRes), true, 'client B should have its own bucket');

      delete process.env.ALEXANDRIA_TRUSTED_PROXY;
    },
  );

  // Final wave (B2): the RIGHTMOST X-Forwarded-For entry, which is the one
  // the trusted last hop appended. The leftmost entry is whatever the
  // original caller sent, so keying on it let a client pick - and keep
  // picking a fresh - rate-limit bucket by sending its own header.
  await t.test(
    'falls back to the rightmost X-Forwarded-For entry when CF-Connecting-IP is absent',
    () => {
      process.env.ALEXANDRIA_TRUSTED_PROXY = '1';
      resetRateLimitForTests();
      const proxyAddress = '10.0.0.1';

      for (let i = 0; i < 60; i++) {
        const { req, res } = fakeReqRes(proxyAddress, {
          'x-forwarded-for': `spoofed-${i}, 198.51.100.20`,
        });
        assert.equal(checkRateLimit(req, res), true);
      }
      // A brand new leftmost entry, same rightmost one: the SAME bucket,
      // so the client cannot escape its own throttle by rewriting the
      // part of the header it controls.
      const { req: exhausted, res: exhaustedRes } = fakeReqRes(proxyAddress, {
        'x-forwarded-for': 'a-totally-fresh-value, 198.51.100.20',
      });
      assert.equal(checkRateLimit(exhausted, exhaustedRes), false);

      const { req: fresh, res: freshRes } = fakeReqRes(proxyAddress, {
        'x-forwarded-for': 'spoofed-0, 198.51.100.21',
      });
      assert.equal(
        checkRateLimit(fresh, freshRes),
        true,
        'a different rightmost entry gets its own bucket',
      );

      delete process.env.ALEXANDRIA_TRUSTED_PROXY;
    },
  );

  await t.test(
    'ignores CF-Connecting-IP/X-Forwarded-For and keys on the socket address when unset',
    () => {
      delete process.env.ALEXANDRIA_TRUSTED_PROXY;
      resetRateLimitForTests();
      const socketAddress = '198.51.100.30';

      // Two requests carrying different spoofed proxy headers, but the
      // SAME socket address, must land in the SAME bucket when the flag
      // is off - proving the headers are ignored, not merely unused.
      for (let i = 0; i < 60; i++) {
        const { req, res } = fakeReqRes(socketAddress, { 'cf-connecting-ip': `203.0.113.${i}` });
        assert.equal(checkRateLimit(req, res), true);
      }
      const { req, res } = fakeReqRes(socketAddress, { 'cf-connecting-ip': '203.0.113.99' });
      assert.equal(checkRateLimit(req, res), false, 'the shared socket-keyed bucket is exhausted');
    },
  );
});

// Final wave (B1): applied unconditionally, the Host check 403s every
// request to any non-loopback deployment whose operator never set
// ALEXANDRIA_ALLOWED_ORIGINS, because such a deployment's Host header is
// its own public hostname and there is no allowlist for it to be in. The
// check now applies when there IS an allowlist, or when the connection
// arrived on a loopback interface (the case DNS rebinding targets).
//
// checkOrigin() is driven directly rather than over a socket: the
// condition reads req.socket.localAddress, and an in-process test server
// can only ever be bound to loopback, so a real round trip could not
// exercise the non-loopback branch at all.
test('checkOrigin: Host-header validation is conditional', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  const publicHost = { host: 'alexandria.example.com' };

  await t.test('a non-loopback Host with no allowlist set is allowed through', () => {
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
    const { req, res, written } = fakeReqRes('203.0.113.9', publicHost, '203.0.113.1');
    assert.equal(checkOrigin(req, res), true);
    assert.equal(written.status, undefined, 'no rejection should have been written');
  });

  await t.test('the same request is 403 once the allowlist names other hosts', () => {
    process.env.ALEXANDRIA_ALLOWED_ORIGINS = 'other.example.org';
    const { req, res, written } = fakeReqRes('203.0.113.9', publicHost, '203.0.113.1');
    assert.equal(checkOrigin(req, res), false);
    assert.equal(written.status, 403);
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
  });

  await t.test('the allowlisted Host passes with the allowlist set', () => {
    process.env.ALEXANDRIA_ALLOWED_ORIGINS = 'alexandria.example.com';
    const { req, res, written } = fakeReqRes('203.0.113.9', publicHost, '203.0.113.1');
    assert.equal(checkOrigin(req, res), true);
    assert.equal(written.status, undefined);
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
  });

  await t.test('a loopback connection still rejects a foreign Host with no allowlist', () => {
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
    const { req, res, written } = fakeReqRes('127.0.0.1', publicHost, '127.0.0.1');
    assert.equal(checkOrigin(req, res), false, 'DNS-rebinding protection still applies locally');
    assert.equal(written.status, 403);
  });

  await t.test('an Origin outside the allowlist is 403 even on a non-loopback connection', () => {
    process.env.ALEXANDRIA_ALLOWED_ORIGINS = 'alexandria.example.com';
    const { req, res, written } = fakeReqRes(
      '203.0.113.9',
      { ...publicHost, origin: 'https://evil.example.net' },
      '203.0.113.1',
    );
    assert.equal(checkOrigin(req, res), false);
    assert.equal(written.status, 403);
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
  });

  await t.test('a request with no Origin header passes the Origin check', () => {
    delete process.env.ALEXANDRIA_ALLOWED_ORIGINS;
    const { req, res, written } = fakeReqRes('203.0.113.9', publicHost, '203.0.113.1');
    assert.equal(checkOrigin(req, res), true);
    assert.equal(written.status, undefined);
  });
});

// Final wave (B2): past the ceiling the map used to be cleared outright,
// handing every tracked client a full bucket at once - so a caller able to
// reach the ceiling could reset its own throttle. Only the oldest-seen
// bucket is dropped now.
test('checkRateLimit: the ceiling evicts the oldest bucket, not every bucket', () => {
  resetRateLimitForTests();
  const firstSeen = '198.51.100.200';

  // Exhaust one client's bucket, then fill the map to its ceiling with
  // other clients. That first client is the oldest entry, so it is the
  // one eviction takes; a client inserted after it must keep its state.
  for (let i = 0; i < 60; i++) {
    const { req, res } = fakeReqRes(firstSeen);
    assert.equal(checkRateLimit(req, res), true);
  }
  const { req: over, res: overRes } = fakeReqRes(firstSeen);
  assert.equal(checkRateLimit(over, overRes), false, 'the first client is throttled');

  // Fill the map to one short of its ceiling with distinct keys.
  let filler = 0;
  while (buckets() < MAX_TRACKED_CLIENTS_FOR_TESTS - 1) {
    const { req, res } = fakeReqRes(`filler-${filler++}`);
    checkRateLimit(req, res);
  }

  // Exhausted LAST, so no wall time passes between here and the final
  // assertion below - the bucket refills continuously (see httpGuards.ts),
  // and the fill loop above takes long enough to hand back a token.
  const secondSeen = '198.51.100.201';
  for (let i = 0; i < 60; i++) {
    const { req, res } = fakeReqRes(secondSeen);
    assert.equal(checkRateLimit(req, res), true);
  }

  assert.equal(
    hasTrackedClientForTests(firstSeen),
    true,
    'the oldest bucket is still held at (not past) the ceiling',
  );

  // One more distinct client crosses the ceiling.
  const { req: crossing, res: crossingRes } = fakeReqRes('198.51.100.202');
  checkRateLimit(crossing, crossingRes);

  assert.equal(
    buckets(),
    MAX_TRACKED_CLIENTS_FOR_TESTS,
    'the map settles at the ceiling instead of growing',
  );
  assert.equal(hasTrackedClientForTests(firstSeen), false, 'the oldest bucket was evicted');
  assert.equal(
    hasTrackedClientForTests(secondSeen),
    true,
    'a newer bucket survives, so the whole map was not cleared',
  );

  // The surviving client is still throttled: its bucket was not reset.
  const { req: still, res: stillRes } = fakeReqRes(secondSeen);
  assert.equal(checkRateLimit(still, stillRes), false);
  resetRateLimitForTests();
});
