import assert from 'node:assert/strict';
import test from 'node:test';
import { tryBrowserRun } from './browserRun.ts';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/acct123/browser-rendering/markdown';
// Loopback: the SSRF guard would otherwise refuse this target outright, and
// these tests stub fetch anyway (no real network reaches it).
const TARGET = 'http://127.0.0.1:1/page';

test('tryBrowserRun', async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  await t.test('posts to the markdown endpoint and returns the rendered markdown', async () => {
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123';
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = 'test-cf-token';

    const calls: Array<{
      url: string;
      method?: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        method: init.method,
        headers: (init.headers as Record<string, string>) ?? {},
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ success: true, result: '# Rendered\n\nBody text.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const page = await tryBrowserRun(TARGET);
    assert.equal(page.via, 'browser-run');
    assert.equal(page.url, TARGET);
    assert.equal(page.text, '# Rendered\n\nBody text.');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.Authorization, 'Bearer test-cf-token');
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(calls[0].body, { url: TARGET });

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
  });

  await t.test('is skipped (no network call) when not configured', async () => {
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch should not have been called');
    }) as typeof fetch;

    await assert.rejects(() => tryBrowserRun(TARGET), /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(fetchCalled, false);
  });

  await t.test(
    'is skipped (no network call) when only the token, not the account id, is set',
    async () => {
      process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = 'test-cf-token';

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('fetch should not have been called');
      }) as typeof fetch;

      await assert.rejects(() => tryBrowserRun(TARGET), /CLOUDFLARE_ACCOUNT_ID/);
      assert.equal(fetchCalled, false);

      delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
    },
  );

  await t.test('rejects a private-range URL before any call, even when configured', async () => {
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK; // let the guard actually refuse loopback
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123';
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = 'test-cf-token';

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch should not have been called');
    }) as typeof fetch;

    await assert.rejects(() => tryBrowserRun(TARGET), /loopback/);
    assert.equal(fetchCalled, false);

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
  });

  await t.test('surfaces a Cloudflare error response', async () => {
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123';
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = 'test-cf-token';

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 2001, message: 'Rate limit exceeded' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    await assert.rejects(() => tryBrowserRun(TARGET), /Rate limit exceeded/);

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
  });

  await t.test('surfaces a non-2xx HTTP response', async () => {
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123';
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = 'test-cf-token';

    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;

    await assert.rejects(() => tryBrowserRun(TARGET), /HTTP 403/);

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
  });
});
