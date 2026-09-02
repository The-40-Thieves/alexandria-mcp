import assert from 'node:assert/strict';
import test from 'node:test';
import { McpClientPool, type RemoteServerConfig } from './mcpClientPool.js';
import { startTestMcpServer, type TestMcpServerHandle } from './mcpTestServer.js';

function cfg(handle: TestMcpServerHandle, name = 'test-server'): RemoteServerConfig {
  return { name, url: handle.url, timeoutMs: 5000 };
}

test('McpClientPool', async (t) => {
  await t.test('call() invokes the named tool and returns text + structuredContent', async () => {
    const handle = await startTestMcpServer({
      search: (args) => ({
        content: [{ type: 'text', text: `found: ${args.query}` }],
        structuredContent: { echoQuery: args.query, echoLimit: args.limit },
      }),
    });
    t.after(() => handle.close());

    const pool = new McpClientPool();
    const result = await pool.call(cfg(handle), 'search', {
      query: 'vision language models',
      limit: 3,
    });

    assert.equal(result.text, 'found: vision language models');
    assert.deepEqual(result.structured, { echoQuery: 'vision language models', echoLimit: 3 });
  });

  await t.test('joins multiple text content items with a blank line', async () => {
    const handle = await startTestMcpServer({
      search: () => ({
        content: [
          { type: 'text', text: 'title: A' },
          { type: 'text', text: 'title: B' },
        ],
      }),
    });
    t.after(() => handle.close());

    const pool = new McpClientPool();
    const result = await pool.call(cfg(handle), 'search', { query: 'x' });
    assert.equal(result.text, 'title: A\n\ntitle: B');
  });

  await t.test('pulls text out of an embedded-text resource content item too', async () => {
    const handle = await startTestMcpServer({
      read: () => ({
        content: [
          { type: 'text', text: 'successfully downloaded text file' },
          {
            type: 'resource',
            resource: { uri: 'repo://o/r/contents/README.md', text: 'file contents here' },
          },
        ],
      }),
    });
    t.after(() => handle.close());

    const pool = new McpClientPool();
    const result = await pool.call(cfg(handle), 'read', { id: 'x' });
    assert.equal(result.text, 'successfully downloaded text file\n\nfile contents here');
  });

  await t.test('reuses one pooled client across repeated calls to the same server', async () => {
    let searchCalls = 0;
    const handle = await startTestMcpServer({
      search: () => {
        searchCalls++;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    t.after(() => handle.close());

    const pool = new McpClientPool();
    const server = cfg(handle);
    await pool.call(server, 'search', { query: 'a' });
    const afterFirst = handle.requestCount();
    await pool.call(server, 'search', { query: 'b' });
    const afterSecond = handle.requestCount();

    assert.equal(searchCalls, 2);
    // A fresh client needs an initialize + notifications/initialized
    // round trip before its first tool call; a second call against the
    // same pool should add exactly one more request (the tools/call
    // itself), not another handshake.
    assert.equal(afterSecond - afterFirst, 1, 'second call should not reconnect');
  });

  await t.test('tools() caches the tool list for repeated calls to the same server', async () => {
    const handle = await startTestMcpServer({});
    t.after(() => handle.close());

    const pool = new McpClientPool();
    const server = cfg(handle);
    const first = await pool.tools(server);
    const afterFirst = handle.requestCount();
    const second = await pool.tools(server);
    const afterSecond = handle.requestCount();

    assert.deepEqual(first, ['read', 'search']);
    assert.deepEqual(second, ['read', 'search']);
    assert.equal(afterSecond, afterFirst, 'a cached tools() call should not hit the server again');
  });

  await t.test(
    'call() retries exactly once with a fresh client when the server is killed and recreated',
    async () => {
      const handleA = await startTestMcpServer({
        search: () => ({ content: [{ type: 'text', text: 'from A' }] }),
      });

      const pool = new McpClientPool();
      const server: RemoteServerConfig = {
        name: 'kill-recreate',
        url: handleA.url,
        timeoutMs: 5000,
      };

      const first = await pool.call(server, 'search', { query: 'x' });
      assert.equal(first.text, 'from A');

      // Kill the server the pool's cached client is still connected to,
      // then recreate a fresh instance (a new ephemeral port, so there is
      // no dependency on OS-level port/keep-alive reuse timing). The pool
      // still has a client pointed at the dead port from handleA; its
      // first attempt against the *same server name* with the *new* url
      // fails for real (nothing is listening on the old port any more),
      // and the retry must connect fresh against handleB's url and
      // succeed.
      await handleA.close();
      const handleB = await startTestMcpServer({
        search: () => ({ content: [{ type: 'text', text: 'from B' }] }),
      });
      try {
        const recreated: RemoteServerConfig = { ...server, url: handleB.url };
        const second = await pool.call(recreated, 'search', { query: 'y' });
        assert.equal(second.text, 'from B');
        // The failed first attempt hit the dead port from handleA, not
        // handleB, so handleB only ever sees the fresh client's own
        // initialize + notifications/initialized + tools/call = 3.
        assert.equal(handleB.requestCount(), 3);
      } finally {
        await handleB.close();
      }
    },
  );

  await t.test(
    'throws an Error prefixed "tool error:" when the result has isError, without reconnecting',
    async () => {
      const handle = await startTestMcpServer({
        read: () => ({ content: [{ type: 'text', text: 'ok' }] }),
        search: () => ({
          content: [{ type: 'text', text: 'bad query: missing field' }],
          isError: true,
        }),
      });
      t.after(() => handle.close());

      const pool = new McpClientPool();
      const server = cfg(handle);
      // Prime a connection via a *different* tool (read) that succeeds,
      // so the isError call below reuses an existing client instead of
      // its own initialize+notify being indistinguishable from a
      // wrongful reconnect.
      await pool.call(server, 'read', { id: 'x' });
      const beforeError = handle.requestCount();

      await assert.rejects(
        pool.call(server, 'search', { query: 'x' }),
        /^Error: tool error: bad query: missing field$/,
      );

      assert.equal(
        handle.requestCount() - beforeError,
        1,
        'a tool-level error should not reconnect (no extra initialize/notify requests), just the one failed tools/call',
      );
    },
  );

  await t.test(
    'two RemoteServerConfigs with different names but the same URL share one client',
    async () => {
      let calls = 0;
      const handle = await startTestMcpServer({
        search: () => {
          calls++;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });
      t.after(() => handle.close());

      const pool = new McpClientPool();
      const serverA: RemoteServerConfig = { name: 'jina', url: handle.url, timeoutMs: 5000 };
      const serverB: RemoteServerConfig = { name: 'jinaarxiv', url: handle.url, timeoutMs: 5000 };

      await pool.call(serverA, 'search', { query: 'a' });
      const afterFirst = handle.requestCount();
      await pool.call(serverB, 'search', { query: 'b' });
      const afterSecond = handle.requestCount();

      assert.equal(calls, 2);
      assert.equal(
        afterSecond - afterFirst,
        1,
        'the second source (different name, same URL) should reuse the connection, not reconnect',
      );
    },
  );

  await t.test(
    'two RemoteServerConfigs with the same URL but different headers do NOT share a client',
    async () => {
      const handle = await startTestMcpServer({
        search: () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });
      t.after(() => handle.close());

      const pool = new McpClientPool();
      const serverA: RemoteServerConfig = {
        name: 'a',
        url: handle.url,
        headers: { Authorization: 'Bearer one' },
        timeoutMs: 5000,
      };
      const serverB: RemoteServerConfig = {
        name: 'b',
        url: handle.url,
        headers: { Authorization: 'Bearer two' },
        timeoutMs: 5000,
      };

      await pool.call(serverA, 'search', { query: 'a' });
      const afterFirst = handle.requestCount();
      await pool.call(serverB, 'search', { query: 'b' });
      const afterSecond = handle.requestCount();

      assert.equal(
        afterSecond - afterFirst,
        3,
        'different headers (different auth) should get their own client: a full initialize + notify + tools/call, not just the tools/call',
      );
    },
  );

  await t.test('does not retry a second time after the retry also fails', async () => {
    const handle = await startTestMcpServer({
      failAlways: true,
      failStatus: 400,
      search: () => ({ content: [{ type: 'text', text: 'unreachable' }] }),
    });
    t.after(() => handle.close());

    const pool = new McpClientPool();
    const server = cfg(handle);
    await assert.rejects(pool.call(server, 'search', { query: 'x' }));
    // One failed attempt (creating the first client) plus exactly one
    // retry attempt (creating a second client): 2 requests total, not a
    // third.
    assert.equal(handle.requestCount(), 2);
  });
});
