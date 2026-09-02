import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry, retryAfterMs } from './http.js';

test('retryAfterMs', async (t) => {
  await t.test('missing header falls back to 1000ms', () => {
    assert.equal(retryAfterMs(null), 1000);
    assert.equal(retryAfterMs(''), 1000);
  });

  await t.test('numeric header within the cap returns that many ms', () => {
    assert.equal(retryAfterMs('2'), 2000);
    assert.equal(retryAfterMs('5', 5000), 5000); // exactly at the cap is allowed
  });

  await t.test('numeric header above the cap returns null (do not sleep/retry)', () => {
    assert.equal(retryAfterMs('86400'), null);
    assert.equal(retryAfterMs('6'), null); // 6000ms > default 5000ms cap
  });

  await t.test('a non-positive numeric header falls back to 1000ms', () => {
    assert.equal(retryAfterMs('0'), 1000);
    assert.equal(retryAfterMs('-5'), 1000);
  });

  await t.test('an HTTP-date header within the cap returns the delta in ms', () => {
    const soon = new Date(Date.now() + 2000).toUTCString();
    const ms = retryAfterMs(soon);
    assert.ok(ms !== null && ms > 0 && ms <= 2000);
  });

  await t.test('an HTTP-date header past the cap returns null', () => {
    const far = new Date(Date.now() + 86400_000).toUTCString();
    assert.equal(retryAfterMs(far), null);
  });

  await t.test('an HTTP-date header already in the past falls back to 1000ms', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    assert.equal(retryAfterMs(past), 1000);
  });

  await t.test('an unparseable header falls back to 1000ms', () => {
    assert.equal(retryAfterMs('not-a-real-value'), 1000);
  });

  await t.test('a custom capMs is honored', () => {
    assert.equal(retryAfterMs('3', 2000), null);
    assert.equal(retryAfterMs('1', 2000), 1000);
  });
});

test('fetchWithRetry', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test(
    'passes redirect and other custom RequestInit fields through to fetch()',
    async () => {
      // fetchTier.ts's SSRF-guarded redirect loop depends on fetchWithRetry
      // forwarding `redirect: 'manual'` (and arbitrary other init fields)
      // straight through to the underlying fetch() call, not defaulting or
      // stripping it.
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
        capturedInit = init;
        return new Response('ok', { status: 200 });
      }) as typeof fetch;

      await fetchWithRetry('https://example.org/x', {
        redirect: 'manual',
        method: 'POST',
        headers: { 'X-Test': 'yes' },
      });

      assert.equal(capturedInit?.redirect, 'manual');
      assert.equal(capturedInit?.method, 'POST');
      assert.equal((capturedInit?.headers as Record<string, string>)?.['X-Test'], 'yes');
    },
  );
});
