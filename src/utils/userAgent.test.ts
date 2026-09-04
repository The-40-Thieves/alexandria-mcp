import assert from 'node:assert/strict';
import test from 'node:test';
import { VERSION } from '../version.ts';
import { fetchWithRetry } from './http.ts';
import { contactUserAgent, fetchUserAgent } from './userAgent.ts';

// Final wave (F1): three different User-Agent strings identified this one
// server. utils/http.ts - the path every REST adapter takes - sent
// `library-mcp-server/1.0 (open source research tool)`, a name this
// project has not used since it was renamed and a version that was never
// true; four adapters hardcoded `alexandria-mcp/10`, frozen at whatever
// major they were written on; only fetchTier.ts's was honest.
test('fetchUserAgent', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('defaults to Alexandria at the package version', () => {
    delete process.env.ALEXANDRIA_FETCH_UA;
    assert.equal(
      fetchUserAgent(),
      `Alexandria/${VERSION} (+https://github.com/The-40-Thieves/alexandria-mcp)`,
    );
  });

  await t.test('ALEXANDRIA_FETCH_UA overrides it', () => {
    process.env.ALEXANDRIA_FETCH_UA = 'MyOrgBot/2 (+https://example.org/bot)';
    assert.equal(fetchUserAgent(), 'MyOrgBot/2 (+https://example.org/bot)');
    delete process.env.ALEXANDRIA_FETCH_UA;
  });
});

test('contactUserAgent', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('folds CONTACT_EMAIL in when set', () => {
    process.env.CONTACT_EMAIL = 'test@example.org';
    assert.equal(contactUserAgent(), `Alexandria/${VERSION} (mailto:test@example.org)`);
  });

  await t.test('falls back to the repo URL when it is not', () => {
    delete process.env.CONTACT_EMAIL;
    assert.equal(
      contactUserAgent(),
      `Alexandria/${VERSION} (+https://github.com/The-40-Thieves/alexandria-mcp)`,
    );
  });
});

// The gate that matters: the UA an adapter actually puts on the wire.
test('fetchWithRetry sends the shared User-Agent, and a per-call override still wins', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });
  delete process.env.ALEXANDRIA_FETCH_UA;

  let sent: string | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    sent = (init.headers as Record<string, string> | undefined)?.['User-Agent'];
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  await fetchWithRetry('https://example.org/x');
  assert.equal(sent, fetchUserAgent());
  assert.ok(!sent?.includes('library-mcp-server'));

  await fetchWithRetry('https://example.org/x', { headers: { 'User-Agent': 'Adapter/1' } });
  assert.equal(sent, 'Adapter/1', 'an adapter that needs its own UA still gets it');
});
