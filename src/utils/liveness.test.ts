import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { type DnsLookupAll, dnsResolver } from '../web/fetchTier.ts';
import { checkLiveness, checkUrlLiveness, MAX_LIVENESS_CHECKS } from './liveness.ts';

// A local http.Server bound to 127.0.0.1, tracking which method reached
// each route - mirrors scripts/eval-answer.test.ts's former checkResolvable
// fixture (this file now owns that suite; eval-answer.ts delegates to
// checkUrlLiveness instead of duplicating the guarded-fetch logic).
interface LivenessServer {
  port: number;
  requests: string[];
  close(): Promise<void>;
}
function startLivenessServer(): Promise<LivenessServer> {
  const requests: string[] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/ok') {
        res.writeHead(200);
        res.end(req.method === 'HEAD' ? undefined : 'ok');
        return;
      }
      if (req.url === '/notfound') {
        res.writeHead(404);
        res.end(req.method === 'HEAD' ? undefined : 'not found');
        return;
      }
      if (req.url === '/head-blocked') {
        if (req.method === 'HEAD') {
          res.writeHead(405);
          res.end();
        } else {
          res.writeHead(200);
          res.end('ok via get');
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, requests, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

test('checkUrlLiveness', async (t) => {
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  // The stubbed hostname below resolves to 127.0.0.1, which classifies as
  // loopback - allowed here the same way fetchTier.test.ts's own
  // guarded-fetch tests allow it, via ALEXANDRIA_ALLOW_LOOPBACK=1. Real
  // citation URLs are ordinary hostnames, which is exactly the case
  // guardedDispatcher's connect.lookup fails closed on without a pin in
  // scope - a literal-IP URL would skip connect.lookup entirely and never
  // exercise that path.
  process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
  dnsResolver.lookup = (async () => [{ address: '127.0.0.1', family: 4 }]) satisfies DnsLookupAll;

  await t.test('a 2xx response counts as live', async () => {
    const server = await startLivenessServer();
    t.after(() => server.close());
    const result = await checkUrlLiveness(`http://liveness-ok.invalid:${server.port}/ok`);
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.deepEqual(
      server.requests,
      ['HEAD /ok'],
      'the guarded fetch must actually have reached the server (proves the pin worked)',
    );
  });

  await t.test('a 404 response does not count as live', async () => {
    const server = await startLivenessServer();
    t.after(() => server.close());
    const result = await checkUrlLiveness(`http://liveness-404.invalid:${server.port}/notfound`);
    assert.equal(result.ok, false);
    // Both methods must have reached the server (a 404 falls back from HEAD
    // to GET) - distinguishes "the server said 404" from "the connection
    // never reached the server at all" (which also reads as ok: false, but
    // for the wrong reason).
    assert.deepEqual(server.requests, ['HEAD /notfound', 'GET /notfound']);
  });

  await t.test('a HEAD 405 falls back to a GET, which counts as live', async () => {
    const server = await startLivenessServer();
    t.after(() => server.close());
    const result = await checkUrlLiveness(
      `http://liveness-head405.invalid:${server.port}/head-blocked`,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(server.requests, ['HEAD /head-blocked', 'GET /head-blocked']);
  });

  await t.test(
    'the guard rejecting a private address counts as not live, without throwing',
    async () => {
      // A literal RFC 1918 address: always blocked, no ALEXANDRIA_ALLOW_LOOPBACK
      // override applies (that only ever covers loopback). No server is
      // started - resolveFetchTarget must reject before any fetch is
      // attempted, and checkUrlLiveness must turn that rejection into
      // { ok: false } rather than letting it propagate.
      const result = await checkUrlLiveness('http://10.1.2.3/');
      assert.equal(result.ok, false);
    },
  );
});

test('checkLiveness', async (t) => {
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
  dnsResolver.lookup = (async () => [{ address: '127.0.0.1', family: 4 }]) satisfies DnsLookupAll;

  await t.test(
    'a second call for the same URL is served from the 24h cache, not re-fetched',
    async () => {
      const server = await startLivenessServer();
      t.after(() => server.close());
      const url = `http://liveness-cache.invalid:${server.port}/ok`;

      const first = await checkLiveness([url]);
      assert.equal(first.get(url)?.ok, true);
      assert.equal(server.requests.length, 1);

      const second = await checkLiveness([url]);
      assert.equal(second.get(url)?.ok, true);
      assert.equal(server.requests.length, 1, 'cached result must not trigger a second fetch');
    },
  );

  await t.test('a duplicate URL in the input is only checked once', async () => {
    const server = await startLivenessServer();
    t.after(() => server.close());
    const url = `http://liveness-dedup.invalid:${server.port}/ok`;

    const results = await checkLiveness([url, url, url]);
    assert.equal(results.size, 1);
    assert.equal(server.requests.length, 1);
  });

  await t.test(`checks at most ${MAX_LIVENESS_CHECKS} distinct URLs`, async () => {
    const server = await startLivenessServer();
    t.after(() => server.close());
    const urls = Array.from(
      { length: MAX_LIVENESS_CHECKS + 5 },
      (_, i) => `http://liveness-cap-${i}.invalid:${server.port}/ok`,
    );

    const results = await checkLiveness(urls);
    assert.equal(results.size, MAX_LIVENESS_CHECKS);
    assert.equal(server.requests.length, MAX_LIVENESS_CHECKS);
  });

  await t.test('a checkable-but-dead URL resolves to ok: false in the map', async () => {
    const server = await startLivenessServer();
    t.after(() => server.close());
    const url = `http://liveness-dead.invalid:${server.port}/notfound`;
    const results = await checkLiveness([url]);
    assert.equal(results.get(url)?.ok, false);
  });
});
