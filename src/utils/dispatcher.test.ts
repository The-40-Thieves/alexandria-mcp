import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cacheStores, fetch as undiciFetch } from 'undici';
import { destinationOverride } from '../log.ts';
import {
  buildCacheStore,
  buildSourceDispatcher,
  guardedDispatcher,
  installDispatcher,
  resetHttpCacheWarningForTests,
} from './dispatcher.ts';

interface FixtureServer {
  url: string;
  hits: number;
  close(): Promise<void>;
}

// A local node:http server on an ephemeral loopback port: /cacheable sets
// Cache-Control: max-age=60 (fresh for the RFC 9111 cache interceptor to
// serve from cacheStore on the second GET), /no-store sets Cache-Control:
// no-store (never cached, always re-fetched). Each response body embeds the
// current hit count, so a test can tell "served from cache" (body frozen at
// the first hit's count) from "re-fetched" (body's count increments) without
// depending on any particular cache-marker header.
function startFixtureServer(): Promise<FixtureServer> {
  const state = { hits: 0 };
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      state.hits += 1;
      if (req.url === '/cacheable') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=60' });
        res.end(`cacheable-${state.hits}`);
        return;
      }
      if (req.url === '/no-store') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(`no-store-${state.hits}`);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get hits() {
          return state.hits;
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test('buildSourceDispatcher: RFC 9111 cache', async (t) => {
  await t.test(
    'a max-age response is served from cache on the second identical GET, hitting the origin once',
    async () => {
      const server = await startFixtureServer();
      t.after(() => server.close());
      const dispatcher = buildSourceDispatcher(':memory:');

      const url = `${server.url}/cacheable`;
      const r1 = await undiciFetch(url, { dispatcher });
      const body1 = await r1.text();
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('age'), null, 'the first response is fresh from the origin');

      const r2 = await undiciFetch(url, { dispatcher });
      const body2 = await r2.text();
      assert.equal(r2.status, 200);
      // The cache interceptor's own marker for "served from the store"
      // (RFC 9111 section 5.1): present only on the cached hit.
      assert.ok(r2.headers.get('age') !== null, 'the second response carries an Age header');
      assert.equal(body2, body1, 'the cached response replays the same body');
      assert.equal(server.hits, 1, 'the origin was hit exactly once for two identical GETs');
    },
  );

  await t.test('a no-store response is re-fetched on every identical GET', async () => {
    const server = await startFixtureServer();
    t.after(() => server.close());
    const dispatcher = buildSourceDispatcher(':memory:');

    const url = `${server.url}/no-store`;
    const r1 = await undiciFetch(url, { dispatcher });
    await r1.text();
    const r2 = await undiciFetch(url, { dispatcher });
    await r2.text();

    assert.equal(server.hits, 2, 'no-store must never be served from the cache');
  });
});

test('buildCacheStore: memory fallback', async (t) => {
  t.afterEach(() => resetHttpCacheWarningForTests());

  await t.test('falls back to MemoryCacheStore when the sqlite location cannot be created', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'alexandria-http-cache-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    // A regular FILE standing in for a path component that must be a
    // directory: fs.mkdirSync(recursive) throws ENOTDIR trying to create
    // a directory "under" it, structurally rather than by permission -
    // unlike a read-only directory (EACCES), this can't be bypassed by
    // running as root, which `unshare -rn`'s user-namespace mapping does,
    // so it stays deterministic under the sandbox this suite must run in.
    const notADirectory = path.join(base, 'blocks-the-path');
    writeFileSync(notADirectory, 'not a directory');
    const unwritableLocation = path.join(notADirectory, 'nested', 'http-cache.db');

    const lines: string[] = [];
    destinationOverride.value = { write: (msg: string) => void lines.push(msg) };
    try {
      const store = buildCacheStore(unwritableLocation);
      assert.ok(
        store instanceof cacheStores.MemoryCacheStore,
        'an unwritable sqlite location must fall back to MemoryCacheStore',
      );
      assert.equal(lines.length, 1, 'the fallback is logged exactly once');
    } finally {
      destinationOverride.value = undefined;
    }
  });

  await t.test('a writable location builds a real SqliteCacheStore, no fallback', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'alexandria-http-cache-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const location = path.join(base, 'nested', 'http-cache.db');

    let warned = 0;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      warned += 1;
      void args;
    };
    try {
      const store = buildCacheStore(location);
      assert.ok(store instanceof cacheStores.SqliteCacheStore);
      assert.equal(warned, 0);
    } finally {
      console.error = originalError;
    }
  });
});

test('installDispatcher', async (t) => {
  await t.test('is idempotent: a second call does not throw or rebuild', () => {
    const originalCache = process.env.ALEXANDRIA_HTTP_CACHE;
    process.env.ALEXANDRIA_HTTP_CACHE = ':memory:';
    t.after(() => {
      if (originalCache === undefined) delete process.env.ALEXANDRIA_HTTP_CACHE;
      else process.env.ALEXANDRIA_HTTP_CACHE = originalCache;
    });
    assert.doesNotThrow(() => installDispatcher());
    assert.doesNotThrow(() => installDispatcher());
  });

  await t.test(
    'the global fetch honors a dispatcher installed via setGlobalDispatcher, and caches through that exact path',
    async () => {
      // The two-line check from the brief's step 1, exercised as an assertion
      // rather than a throwaway script: Node's global fetch() picks up a
      // dispatcher set through the external `undici` package's
      // setGlobalDispatcher, with no explicit `dispatcher` option on the call
      // itself.
      const server = await startFixtureServer();
      t.after(() => server.close());
      const originalCache = process.env.ALEXANDRIA_HTTP_CACHE;
      process.env.ALEXANDRIA_HTTP_CACHE = ':memory:';
      t.after(() => {
        if (originalCache === undefined) delete process.env.ALEXANDRIA_HTTP_CACHE;
        else process.env.ALEXANDRIA_HTTP_CACHE = originalCache;
      });
      installDispatcher();

      const res1 = await fetch(`${server.url}/cacheable`);
      assert.equal(res1.status, 200);
      assert.equal(await res1.text(), 'cacheable-1');

      // Production's actual call shape: the ambient global fetch(), no
      // explicit `dispatcher` option, relying entirely on the
      // setGlobalDispatcher() install above - not undiciFetch(url,
      // {dispatcher}) (a different handler path; see buildSourceDispatcher's
      // own tests above) and not header inspection (the `age` marker those
      // tests use is non-null via undiciFetch but null via the global fetch
      // for this exact same cache, a real behavioral difference between the
      // two call shapes). Origin hit count is the one signal common to both.
      const res2 = await fetch(`${server.url}/cacheable`);
      assert.equal(res2.status, 200);
      assert.equal(await res2.text(), 'cacheable-1', 'the cached response replays the same body');
      assert.equal(
        server.hits,
        1,
        'two identical GETs through the global fetch must hit the origin once',
      );
    },
  );

  await t.test(
    'the global fetch honors an explicit dispatcher option (undici 7.x/legacy-handler compatibility)',
    async () => {
      // A smoke test: proves the real global fetch() accepts guardedDispatcher
      // - the exact object fetchTier.ts's guarded fetches pass as an
      // explicit `dispatcher` option - as it stands today. It is also a
      // verified (not merely hoped-for) regression trap for the specific
      // constraint package.json's undici pin exists to protect: re-run
      // manually with the installed `undici` package temporarily bumped to
      // 8.10.1 (`npm install undici@8.10.1 --no-save`), this exact test
      // fails with "invalid onRequestStart method" - see dispatcher.ts's
      // module comment for the full mechanism. A literal-IP target, so
      // guardedDispatcher's connect.lookup pin is never even consulted
      // (undici's connector skips DNS/connect.lookup entirely for a literal
      // IP) - this test is purely about whether the global fetch accepts
      // the `dispatcher` option at all, decoupled from pinning.
      const server = await startFixtureServer();
      t.after(() => server.close());

      const res = await fetch(`${server.url}/no-store`, {
        dispatcher: guardedDispatcher,
      } as RequestInit);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'no-store-1');
    },
  );
});
