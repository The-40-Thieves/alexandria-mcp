import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestMcpServer, type TestMcpServerHandle } from '../../utils/mcpTestServer.js';
import { catalog, getAdapter, register } from '../registry.js';
import { defineMcpSource, defineMcpSourceWithDelegatedRead, mcpProbeEntries } from './mcp.js';

function baseSpec(handle: TestMcpServerHandle, name: string) {
  return {
    name,
    description: 'a test mcp source',
    cluster: 'developer' as const,
    freshness: 'daily' as const,
    homepage: 'https://example.invalid',
    supportsIngest: true,
    server: { name, url: handle.url, timeoutMs: 5000 },
  };
}

test('defineMcpSource', async (t) => {
  await t.test('search() calls the configured tool and normalizes its result', async () => {
    const handle = await startTestMcpServer({
      search: (args) => ({
        content: [{ type: 'text', text: `raw: ${args.query}` }],
        structuredContent: { hits: [{ id: '1', title: `title for ${args.query}` }] },
      }),
    });
    t.after(() => handle.close());

    defineMcpSource({
      ...baseSpec(handle, 'mcp_test_search'),
      search: {
        tool: 'search',
        args: (q, limit) => ({ query: q, limit }),
        normalize: (_text, structured, q) => {
          const s = structured as { hits: Array<{ id: string; title: string }> };
          return s.hits.map((h) => ({
            id: h.id,
            source: 'mcp_test_search',
            title: h.title,
            authors: [],
            hasFullText: false,
            description: `query was ${q}`,
          }));
        },
      },
    });

    const results = await getAdapter('mcp_test_search').search('quantum computing', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'title for quantum computing');
    assert.equal(results[0].description, 'query was quantum computing');
  });

  await t.test('read() delegates to the configured tool and normalizes its result', async () => {
    const handle = await startTestMcpServer({
      read: (args) => ({ content: [{ type: 'text', text: `document ${args.id}` }] }),
    });
    t.after(() => handle.close());

    defineMcpSource({
      ...baseSpec(handle, 'mcp_test_read'),
      search: { tool: 'search', args: (q) => ({ q }), normalize: () => [] },
      read: {
        tool: 'read',
        args: (id) => ({ id }),
        normalize: (text, _structured, id) => ({
          title: id,
          authors: [],
          text,
        }),
      },
    });

    const result = await getAdapter('mcp_test_read').read('doc-42');
    assert.equal(result.title, 'doc-42');
    assert.equal((result as { text?: string }).text, 'document doc-42');
  });

  await t.test('read() without a read spec throws "does not support read()"', async () => {
    const handle = await startTestMcpServer({});
    t.after(() => handle.close());

    defineMcpSource({
      ...baseSpec(handle, 'mcp_test_noread'),
      search: { tool: 'search', args: (q) => ({ q }), normalize: () => [] },
    });

    await assert.rejects(getAdapter('mcp_test_noread').read('x'), /does not support read/);
  });

  await t.test(
    'a server resolver returning null hides the source and search() reports a configuration error',
    async () => {
      defineMcpSource({
        name: 'mcp_test_unconfigured',
        description: 'needs a token',
        cluster: 'developer',
        freshness: 'daily',
        homepage: 'https://example.invalid',
        supportsIngest: true,
        server: () => null,
        search: { tool: 'search', args: (q) => ({ q }), normalize: () => [] },
      });

      assert.ok(!catalog().some((s) => s.name === 'mcp_test_unconfigured'));
      await assert.rejects(
        getAdapter('mcp_test_unconfigured').search('x', 1),
        /mcp_test_unconfigured requires .*token/,
      );
    },
  );

  await t.test('records a probe entry with the resolved server and expectTools', async () => {
    const handle = await startTestMcpServer({});
    t.after(() => handle.close());

    defineMcpSource({
      ...baseSpec(handle, 'mcp_test_probe_entry'),
      search: { tool: 'search', args: (q) => ({ q }), normalize: () => [] },
      expectTools: ['search', 'read'],
    });

    const entry = mcpProbeEntries.find((e) => e.name === 'mcp_test_probe_entry');
    assert.ok(entry);
    assert.deepEqual(entry?.expectTools, ['search', 'read']);
    assert.deepEqual(entry?.resolveServer(), {
      name: 'mcp_test_probe_entry',
      url: handle.url,
      timeoutMs: 5000,
    });
  });

  await t.test(
    'defineMcpSourceWithDelegatedRead: search() still calls the tool, read() bypasses the server entirely',
    async () => {
      let delegateReadCalls = 0;
      register('mcp_test_delegate_target', {
        description: 'stand-in for e.g. arxiv',
        supportsIngest: true,
        async search() {
          return [];
        },
        async read(id) {
          delegateReadCalls++;
          return { title: `delegated ${id}`, authors: [] };
        },
      });

      const handle = await startTestMcpServer({
        search: () => ({
          content: [{ type: 'text', text: 'ignored' }],
          structuredContent: { ok: true },
        }),
      });
      t.after(() => handle.close());

      defineMcpSourceWithDelegatedRead(
        {
          ...baseSpec(handle, 'mcp_test_delegating_source'),
          search: {
            tool: 'search',
            args: (q) => ({ query: q }),
            normalize: () => [{ id: '1', source: 'x', title: 't', authors: [], hasFullText: true }],
          },
        },
        (id) => getAdapter('mcp_test_delegate_target').read(id),
      );

      const results = await getAdapter('mcp_test_delegating_source').search('x', 5);
      assert.equal(results.length, 1);

      const read = await getAdapter('mcp_test_delegating_source').read('2407.06581');
      assert.equal(read.title, 'delegated 2407.06581');
      assert.equal(delegateReadCalls, 1);
    },
  );
});
