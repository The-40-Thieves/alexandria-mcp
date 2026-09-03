import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJSON, fetchText, fetchWithRetry, redactUrl, retryAfterMs } from './http.ts';

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

// Final wave, A3: about a dozen source adapters put their API key in the
// query string, and fetchJSON/fetchText put the request URL verbatim into
// a thrown Error's message - which scripts/probe.ts captures and
// .github/workflows/probe.yml uploads as a public artifact / interpolates
// into a public issue. redactUrl() (and the two throw sites that use it)
// must never let a credential-shaped query parameter's value survive into
// that message.
test('redactUrl', async (t) => {
  await t.test('masks a query parameter whose name reads as a credential', () => {
    const redacted = redactUrl('https://x.example/?api_key=abc');
    assert.ok(!redacted.includes('abc'), redacted);
    assert.match(redacted, /api_key=%5BRedacted%5D|api_key=\[Redacted\]/);
  });

  await t.test('masks every credential-shaped variant this repo actually uses', () => {
    for (const param of ['api_key', 'apikey', 'apiKey', 'token', 'access_token', 'secret']) {
      const redacted = redactUrl(`https://x.example/search?${param}=abc&q=physics`);
      assert.ok(!redacted.includes('abc'), `${param}: ${redacted}`);
      assert.ok(redacted.includes('q=physics'), 'a non-credential param is left untouched');
    }
  });

  await t.test(
    'a URL with no credential-shaped parameter is unchanged apart from normalization',
    () => {
      const redacted = redactUrl('https://x.example/search?q=physics&limit=5');
      assert.ok(redacted.includes('q=physics'));
      assert.ok(redacted.includes('limit=5'));
    },
  );

  await t.test('a string that does not parse as a URL is returned unchanged', () => {
    assert.equal(redactUrl('not a url'), 'not a url');
  });
});

test('fetchJSON/fetchText error messages never carry a redacted query value', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () => new Response('server error', { status: 500 })) as typeof fetch;

  await t.test('fetchJSON', async () => {
    await assert.rejects(
      () => fetchJSON('https://x.example/?api_key=abc', {}, 1000, 0),
      (err: Error) => {
        assert.ok(!err.message.includes('abc'), err.message);
        return true;
      },
    );
  });

  await t.test('fetchText', async () => {
    await assert.rejects(
      () => fetchText('https://x.example/?api_key=abc', {}, 1000, 0),
      (err: Error) => {
        assert.ok(!err.message.includes('abc'), err.message);
        return true;
      },
    );
  });
});
