import assert from 'node:assert/strict';
import test from 'node:test';
import { dnsResolver } from '../web/urlGuard.ts';
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

// Final wave (C2): fetchJSON/fetchText handed `fetch` its follow-redirects
// default and then read the whole body with response.json()/.text(). Every
// REST adapter, the open-access hops, the citation walk, PMC and doi.org's
// content negotiation come through here, and a `Location` header is
// upstream-controlled - so a redirect into a private address was followed
// unchecked, and an unbounded body was buffered whole after fetchWithRetry
// had already cleared its per-attempt timer on the response headers.
test('fetchJSON/fetchText: guarded redirects and a streamed body cap', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
  });

  // Every hostname the guard is asked about resolves publicly, so a
  // rejection below can only come from the URL itself, never from DNS.
  dnsResolver.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  function redirectingFetch(chain: Record<string, string>, final: unknown): typeof fetch {
    return (async (url: string) => {
      const next = chain[url];
      if (next) {
        return new Response(null, { status: 302, headers: { location: next } });
      }
      return new Response(JSON.stringify(final), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  await t.test('a redirect to a private IP literal is refused, not followed', async () => {
    let reachedPrivate = false;
    globalThis.fetch = (async (url: string) => {
      if (url.startsWith('http://169.254.169.254')) {
        reachedPrivate = true;
        return new Response('{"secret":"instance-metadata"}', { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }) as typeof fetch;

    await assert.rejects(
      () => fetchJSON('https://api.example.org/works/10.1000/x', {}, 1000, 0),
      /private|refus/i,
    );
    assert.equal(reachedPrivate, false, 'the metadata address must never be fetched');
  });

  await t.test('a redirect to 0.0.0.0 is refused too', async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://0.0.0.0:8080/internal' },
      })) as typeof fetch;
    await assert.rejects(
      () => fetchText('https://doi.org/10.1000/x', {}, 1000, 0),
      /private|refus/i,
    );
  });

  await t.test('a two-hop public redirect chain still parses', async () => {
    globalThis.fetch = redirectingFetch(
      {
        'https://doi.org/10.1000/x': 'https://link.example.org/article/1',
        'https://link.example.org/article/1': 'https://cdn.example.org/article/1.json',
      },
      { title: 'A paper' },
    );
    const data = await fetchJSON<{ title: string }>('https://doi.org/10.1000/x', {}, 1000, 0);
    assert.equal(data.title, 'A paper');
  });

  await t.test('more than five redirects is an error, not an infinite loop', async () => {
    globalThis.fetch = (async (url: string) =>
      new Response(null, {
        status: 302,
        headers: { location: `${url}/again` },
      })) as typeof fetch;
    await assert.rejects(
      () => fetchText('https://example.org/loop', {}, 1000, 0),
      /more than 5 redirects/,
    );
  });

  await t.test('a body over the cap is rejected while streaming', async () => {
    // Twelve 1 MB chunks, no content-length: the cap can only be enforced
    // by counting bytes as they arrive.
    globalThis.fetch = (async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(120);
      let sent = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent >= 12) {
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await assert.rejects(
      () => fetchText('https://example.org/huge', {}, 5000, 0),
      /exceeded the 10485760-byte cap/,
    );
  });

  await t.test('an honest oversized content-length is rejected on the header alone', async () => {
    globalThis.fetch = (async () =>
      new Response('short body, dishonest header', {
        status: 200,
        headers: { 'content-length': String(20 * 1024 * 1024) },
      })) as typeof fetch;

    await assert.rejects(
      () => fetchText('https://example.org/huge', {}, 1000, 0),
      /declares 20971520 bytes, over the 10485760-byte cap/,
    );
  });

  await t.test('a per-call maxBytes raises the cap for a catalog download', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-length': String(20 * 1024 * 1024) },
      })) as typeof fetch;

    const data = await fetchJSON<{ ok: boolean }>(
      'https://example.org/catalog.json',
      { maxBytes: 48 * 1024 * 1024 },
      1000,
      0,
    );
    assert.equal(data.ok, true);
  });
});

// Re-review round 2: two gaps in the C2 redirect loop.
//
// (a) Every hop was VALIDATED but none was PINNED, so a hostname that
// resolved publicly for assertFetchableUrl and privately a moment later at
// connect time went unnoticed - the exact TOCTOU gap the guard exists to
// close, and the one fetchTier.ts's own redirect loop has always closed by
// pinning each hop to the addresses resolveFetchTarget just validated.
//
// (b) The original method and body were replayed on every hop, so a
// redirected POST was re-POSTed to the new location: a body, and for the
// adapters that POST a key-bearing payload a credential with it, sent
// somewhere the caller never addressed. Per the fetch spec, 303 always
// becomes a GET and 301/302 become a GET when the request was a POST.
test('fetchJSON/fetchText: redirect hops are pinned and re-methoded', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
  });

  await t.test('a redirect hop connects through the guarded, pinned dispatcher', async () => {
    const lookedUp: string[] = [];
    dnsResolver.lookup = (async (hostname: string) => {
      lookedUp.push(hostname);
      return [{ address: '93.184.216.34', family: 4 }];
    }) as typeof dnsResolver.lookup;

    const dispatchers: Array<unknown> = [];
    globalThis.fetch = (async (url: string, init: RequestInit & { dispatcher?: unknown } = {}) => {
      dispatchers.push(init.dispatcher);
      if (url === 'https://start.example.org/a') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://hop.example.org/b' },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await fetchJSON('https://start.example.org/a', {}, 1000, 0);

    assert.equal(dispatchers.length, 2);
    assert.equal(dispatchers[0], undefined, 'hop 0 keeps the plain dispatcher, per the ruling');
    assert.ok(dispatchers[1], 'the redirect hop must carry the guarded dispatcher');
    // The pin comes from the SAME lookup that validated the hop: exactly
    // one resolution of the redirect target, not one to check and another
    // to connect (which would reopen the race).
    assert.deepEqual(lookedUp, ['hop.example.org']);
  });

  await t.test('a 302 on a POST becomes a GET with no body', async () => {
    dnsResolver.lookup = (async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as typeof dnsResolver.lookup;

    const seen: Array<{ url: string; method?: string; body: unknown; headers: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, method: init.method, body: init.body, headers: init.headers });
      if (url === 'https://api.example.org/search') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://api.example.org/results/1' },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await fetchJSON(
      'https://api.example.org/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({ q: 'physics', api_key: 'secret' }),
      },
      1000,
      0,
    );

    assert.equal(seen[0].method, 'POST', 'the first hop is the request the caller made');
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[1].body, undefined, 'the body must not be replayed to the new location');
    const headers = seen[1].headers as Record<string, string>;
    assert.equal(headers['Content-Type'], undefined, 'the dropped body drops its content-type');
    assert.equal(
      headers.Authorization,
      'Bearer secret-token',
      'other headers are preserved, matching fetch semantics',
    );
  });

  await t.test('a 303 becomes a GET even from a non-POST method', async () => {
    dnsResolver.lookup = (async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as typeof dnsResolver.lookup;

    const methods: Array<string | undefined> = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      methods.push(init.method);
      if (url.endsWith('/put')) {
        return new Response(null, { status: 303, headers: { location: 'https://x.example/done' } });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await fetchText('https://x.example/put', { method: 'PUT', body: 'payload' }, 1000, 0);
    assert.deepEqual(methods, ['PUT', 'GET']);
  });

  await t.test('a 307 preserves the method and body', async () => {
    dnsResolver.lookup = (async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as typeof dnsResolver.lookup;

    const seen: Array<{ method?: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      seen.push({ method: init.method, body: init.body });
      if (url.endsWith('/a')) {
        return new Response(null, { status: 307, headers: { location: 'https://x.example/b' } });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await fetchText('https://x.example/a', { method: 'POST', body: 'payload' }, 1000, 0);
    assert.deepEqual(
      seen.map((s) => s.method),
      ['POST', 'POST'],
    );
    assert.equal(seen[1].body, 'payload', '307 is the status that exists to preserve the body');
  });
});
