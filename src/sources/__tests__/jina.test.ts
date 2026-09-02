import assert from 'node:assert/strict';
import test from 'node:test';
import '../mcp/jina.js';
import { pool } from '../../utils/mcpClientPool.js';
import { getAdapter } from '../registry.js';

// jina's read() delegates to the remote server's read_url tool, which fetches
// whatever URL it is handed. Without a guard that made the source an SSRF
// proxy for any caller-supplied id, one hop removed from the web fetch tier.
test('jina read() SSRF guard', async (t) => {
  const originalCall = pool.call.bind(pool);
  let poolCalls = 0;
  pool.call = (async () => {
    poolCalls += 1;
    throw new Error('POOL_WAS_CALLED');
  }) as typeof pool.call;
  t.after(() => {
    pool.call = originalCall;
  });

  const jina = getAdapter('jina');

  await t.test('rejects a private-network target before any pool call', async () => {
    await assert.rejects(() => jina.read('http://10.0.0.5/admin'), /private-network/);
    assert.equal(poolCalls, 0, 'the guard must run before the remote server is reached');
  });

  await t.test('rejects a loopback target before any pool call', async () => {
    await assert.rejects(() => jina.read('http://127.0.0.1:22/'), /loopback|private-network/);
    assert.equal(poolCalls, 0);
  });

  await t.test('rejects a non-http scheme before any pool call', async () => {
    await assert.rejects(() => jina.read('file:///etc/passwd'), /non-http/);
    assert.equal(poolCalls, 0);
  });

  await t.test('a public target does reach the pool', async () => {
    await assert.rejects(() => jina.read('https://example.com/article'), /POOL_WAS_CALLED/);
    assert.equal(poolCalls, 1, 'the guard must not block an ordinary public URL');
  });
});
