import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  assertConfiguredServiceUrl,
  assertFetchableUrl,
  type DnsLookupAll,
  dnsResolver,
  fetchAsText,
} from './fetchTier.js';

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), 'eval/fixtures/web', name), 'utf8');
}

interface FixtureServer {
  url: string;
  crawlRequests: unknown[];
  close(): Promise<void>;
}

// A local node:http fixture server on an ephemeral port: /article (an
// extractable article-like page), /tiny (under the 500-char threshold, to
// force tier 2/3 selection), /broken (a 500), /crawl (a stand-in for a
// crawl4ai server, when CRAWL4AI_URL is pointed at this server),
// /redirect-to-article (a single same-origin redirect), /redirect-loop (a
// redirect to itself, forever, to exercise the hop cap), /redirect-to-private
// (a redirect to a private-network target, to exercise per-hop guarding),
// /huge (a 6 MB body sent chunked with no Content-Length, to exercise the
// streaming size cap), and /huge-declared (a 6 MB body with an honest,
// oversized Content-Length, to exercise the fast-reject path). `hugeCrawl`
// makes /crawl itself stream an oversized chunked body instead of its
// normal JSON, to exercise the same streaming size cap on tier 3.
function startFixtureServer(crawlResponse?: unknown, hugeCrawl = false): Promise<FixtureServer> {
  const crawlRequests: unknown[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fixture('article.html'));
        return;
      }
      if (req.method === 'GET' && req.url === '/tiny') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fixture('tiny.html'));
        return;
      }
      if (req.method === 'GET' && req.url === '/broken') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
        return;
      }
      if (req.method === 'GET' && req.url === '/redirect-to-article') {
        res.writeHead(302, { Location: '/article' });
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/redirect-loop') {
        res.writeHead(302, { Location: '/redirect-loop' });
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/redirect-to-private') {
        res.writeHead(302, { Location: 'http://10.1.2.3/secret' });
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const chunk = 'x'.repeat(1024 * 1024); // 1 MB, sent 6 times: no Content-Length (chunked)
        let sent = 0;
        const writeNext = () => {
          if (sent >= 6) {
            res.end();
            return;
          }
          sent += 1;
          res.write(chunk, () => writeNext());
        };
        writeNext();
        return;
      }
      if (req.method === 'GET' && req.url === '/huge-declared') {
        const size = 6 * 1024 * 1024;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(size),
        });
        res.end('x'.repeat(1000)); // body itself is short; the declared header is what's tested
        return;
      }
      if (req.method === 'POST' && req.url === '/crawl') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          crawlRequests.push(JSON.parse(body || '{}'));
          if (hugeCrawl) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const chunk = 'x'.repeat(1024 * 1024); // 1 MB, sent 6 times: no Content-Length (chunked)
            let sent = 0;
            const writeNext = () => {
              if (sent >= 6) {
                res.end();
                return;
              }
              sent += 1;
              res.write(chunk, () => writeNext());
            };
            writeNext();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              crawlResponse ?? {
                results: [
                  {
                    success: true,
                    markdown: { fit_markdown: 'crawl4ai extracted this article body. '.repeat(20) },
                    metadata: { title: 'Crawl4ai Title' },
                  },
                ],
              },
            ),
          );
        });
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
        crawlRequests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test('assertFetchableUrl', async (t) => {
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  // Default every ordinary hostname (not a literal IP) to a public address,
  // so these tests never depend on real DNS/network; individual tests
  // override this to simulate "this hostname resolves to a private address".
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) satisfies DnsLookupAll;
  t.after(() => {
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });

  await t.test('rejects a non-http(s) URL', async () => {
    await assert.rejects(() => assertFetchableUrl('file:///etc/passwd'), /non-http/);
  });

  await t.test('rejects ftp: and data: schemes', async () => {
    await assert.rejects(() => assertFetchableUrl('ftp://example.com/file'), /non-http/);
    await assert.rejects(() => assertFetchableUrl('data:text/plain;base64,aGVsbG8='), /non-http/);
  });

  await t.test('rejects an unparseable URL', async () => {
    await assert.rejects(() => assertFetchableUrl('not a url'), /not a valid URL/);
  });

  await t.test('normalizes an uppercase scheme and allows an ordinary public host', async () => {
    await assert.doesNotReject(() => assertFetchableUrl('HTTP://EXAMPLE.com/path'));
  });

  await t.test('rejects a URL carrying embedded credentials', async () => {
    await assert.rejects(() => assertFetchableUrl('http://user:pass@example.com/'), /credentials/);
  });

  await t.test('rejects localhost by default', async () => {
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
    await assert.rejects(() => assertFetchableUrl('http://localhost:8080/x'), /loopback/);
  });

  await t.test('rejects 127.0.0.1 by default', async () => {
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
    await assert.rejects(() => assertFetchableUrl('http://127.0.0.1:8080/x'), /loopback/);
  });

  await t.test('allows loopback when ALEXANDRIA_ALLOW_LOOPBACK=1', async () => {
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    await assert.doesNotReject(() => assertFetchableUrl('http://127.0.0.1:8080/x'));
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
  });

  await t.test('rejects RFC 1918, CGNAT, and link-local ranges with no override', async () => {
    const hosts = [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      '169.254.169.254', // cloud instance-metadata address
      '100.64.0.1', // carrier-grade NAT (RFC 6598)
      '0.0.0.0',
      '224.0.0.1', // multicast
      '255.255.255.255', // reserved/broadcast
    ];
    for (const host of hosts) {
      await assert.rejects(() => assertFetchableUrl(`http://${host}/x`), /private-network/, host);
    }
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    await assert.rejects(() => assertFetchableUrl('http://10.1.2.3/x'), /private-network/);
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
  });

  await t.test('rejects non-canonical IPv4 literal forms once normalized', async () => {
    // The WHATWG URL parser normalizes these to 127.0.0.1 before this code
    // ever sees the hostname.
    await assert.rejects(() => assertFetchableUrl('http://2130706433/'), /loopback/); // decimal
    await assert.rejects(() => assertFetchableUrl('http://0177.0.0.1/'), /loopback/); // octal
    await assert.rejects(() => assertFetchableUrl('http://127.1/'), /loopback/); // shorthand
  });

  await t.test('rejects IPv6 loopback, link-local, and unique-local literals', async () => {
    await assert.rejects(() => assertFetchableUrl('http://[::1]/'), /loopback/);
    await assert.rejects(() => assertFetchableUrl('http://[::]/'), /private-network/);
    await assert.rejects(() => assertFetchableUrl('http://[fe80::1]/'), /private-network/);
    await assert.rejects(() => assertFetchableUrl('http://[fc00::1]/'), /private-network/);
  });

  await t.test('rejects an IPv4-mapped IPv6 literal (::ffff:127.0.0.1)', async () => {
    await assert.rejects(() => assertFetchableUrl('http://[::ffff:127.0.0.1]/'), /loopback/);
  });

  await t.test('rejects .internal and .local hostnames', async () => {
    await assert.rejects(() => assertFetchableUrl('http://box.internal/x'), /private-network/);
    await assert.rejects(() => assertFetchableUrl('http://printer.local/x'), /private-network/);
  });

  await t.test(
    'a caller-supplied target on a configured service host is still refused',
    async () => {
      // The old allowlist matched on hostname alone, so any URL naming the
      // crawl4ai or SearXNG host got through the private-network guard on
      // any port and any scheme. These hosts are tailnet/private addresses:
      // as fetch TARGETS they must be rejected like any other private
      // address, including at the service's own port.
      process.env.CRAWL4AI_URL = 'http://100.78.123.100:11235';
      process.env.SEARXNG_URL = 'http://192.168.1.50:8888';
      await assert.rejects(
        () => assertFetchableUrl('http://100.78.123.100:22/'),
        /private-network/,
        'another port on the crawl4ai host',
      );
      await assert.rejects(
        () => assertFetchableUrl('https://100.78.123.100:11235/health'),
        /private-network/,
        'another scheme on the crawl4ai origin',
      );
      await assert.rejects(
        () => assertFetchableUrl('http://100.78.123.100:11235/health'),
        /private-network/,
        'even the exact service origin, as a caller-supplied target',
      );
      await assert.rejects(
        () => assertFetchableUrl('http://192.168.1.50:9999/'),
        /private-network/,
        'another port on the SearXNG host',
      );
      delete process.env.CRAWL4AI_URL;
      delete process.env.SEARXNG_URL;
    },
  );

  await t.test('assertConfiguredServiceUrl matches the whole origin, not the host', () => {
    process.env.CRAWL4AI_URL = 'http://100.78.123.100:11235';
    process.env.SEARXNG_URL = 'http://192.168.1.50:8888';
    // The server's own outbound calls to the configured endpoints pass.
    assert.doesNotThrow(() => assertConfiguredServiceUrl('http://100.78.123.100:11235/crawl'));
    assert.doesNotThrow(() => assertConfiguredServiceUrl('http://192.168.1.50:8888/search'));
    // A different port, scheme, or host on the same box does not.
    assert.throws(
      () => assertConfiguredServiceUrl('http://100.78.123.100:22/'),
      /outside the configured origins/,
    );
    assert.throws(
      () => assertConfiguredServiceUrl('https://100.78.123.100:11235/crawl'),
      /outside the configured origins/,
    );
    assert.throws(
      () => assertConfiguredServiceUrl('http://100.78.123.101:11235/crawl'),
      /outside the configured origins/,
    );
    delete process.env.CRAWL4AI_URL;
    delete process.env.SEARXNG_URL;
  });

  await t.test('rejects a hostname that resolves to a private address', async () => {
    dnsResolver.lookup = (async () => [{ address: '10.9.9.9', family: 4 }]) satisfies DnsLookupAll;
    await assert.rejects(() => assertFetchableUrl('http://evil.example.com/'), /private-network/);
    dnsResolver.lookup = (async () => [
      { address: '93.184.216.34', family: 4 },
    ]) satisfies DnsLookupAll;
  });

  await t.test('rejects a hostname with any resolved address private (multi-answer)', async () => {
    dnsResolver.lookup = (async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 }, // one bad answer is enough
    ]) satisfies DnsLookupAll;
    await assert.rejects(() => assertFetchableUrl('http://mixed.example.com/'), /private-network/);
    dnsResolver.lookup = (async () => [
      { address: '93.184.216.34', family: 4 },
    ]) satisfies DnsLookupAll;
  });

  await t.test('allows an ordinary public https URL', async () => {
    await assert.doesNotReject(() => assertFetchableUrl('https://example.com/article'));
  });
});

test('fetchAsText', async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';

  await t.test('tier 1: defuddle extracts an article page directly', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    const server = await startFixtureServer();
    t.after(() => server.close());

    const page = await fetchAsText(`${server.url}/article`);
    assert.equal(page.via, 'defuddle');
    assert.ok(page.text.length >= 500, `expected >= 500 chars, got ${page.text.length}`);
    assert.equal(page.title, 'A Long Enough Article About Testing');
  });

  await t.test(
    'tier 2: falls through to jina when defuddle text is short and JINA_API_KEY is set',
    async () => {
      delete process.env.CRAWL4AI_URL;
      process.env.JINA_API_KEY = 'test-jina-key';
      const server = await startFixtureServer();
      t.after(() => server.close());

      const jinaCalls: Array<{ url: string; headers: Record<string, string> }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/')) {
          jinaCalls.push({ url, headers: (init.headers as Record<string, string>) ?? {} });
          return new Response('Title: Jina Title\n\nMarkdown Content:\nExtracted via jina.', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        return originalFetch(input as string, init);
      }) as typeof fetch;

      const target = `${server.url}/tiny`;
      const page = await fetchAsText(target);
      assert.equal(page.via, 'jina');
      assert.equal(page.title, 'Jina Title');
      assert.equal(page.text, 'Extracted via jina.');
      assert.equal(jinaCalls.length, 1);
      assert.equal(jinaCalls[0].url, `https://r.jina.ai/${target}`);
      assert.equal(jinaCalls[0].headers.Authorization, 'Bearer test-jina-key');

      delete process.env.JINA_API_KEY;
    },
  );

  await t.test('tier 3: falls through to crawl4ai when CRAWL4AI_URL is set', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    const server = await startFixtureServer();
    t.after(() => server.close());
    process.env.CRAWL4AI_URL = server.url;

    const target = `${server.url}/tiny`;
    const page = await fetchAsText(target);
    assert.equal(page.via, 'crawl4ai');
    assert.equal(page.title, 'Crawl4ai Title');
    assert.match(page.text, /crawl4ai extracted this article body/);
    assert.equal(server.crawlRequests.length, 1);
    assert.deepEqual((server.crawlRequests[0] as { urls: string[] }).urls, [target]);

    delete process.env.CRAWL4AI_URL;
  });

  await t.test('throws the last tier error once every configured tier fails', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    const server = await startFixtureServer({ results: [{ success: false }] });
    t.after(() => server.close());
    process.env.CRAWL4AI_URL = server.url;

    await assert.rejects(() => fetchAsText(`${server.url}/broken`), /crawl4ai/);

    delete process.env.CRAWL4AI_URL;
  });

  await t.test('throws when no tier is configured and defuddle fails', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    const server = await startFixtureServer();
    t.after(() => server.close());

    await assert.rejects(() => fetchAsText(`${server.url}/broken`), /defuddle/);
  });

  await t.test('follows a same-origin redirect through to a successful extraction', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    const server = await startFixtureServer();
    t.after(() => server.close());

    const page = await fetchAsText(`${server.url}/redirect-to-article`);
    assert.equal(page.via, 'defuddle');
    assert.equal(page.title, 'A Long Enough Article About Testing');
    assert.equal(page.url, `${server.url}/article`); // reflects the final, post-redirect URL
  });

  await t.test('throws after more than 5 redirects', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    const server = await startFixtureServer();
    t.after(() => server.close());

    await assert.rejects(() => fetchAsText(`${server.url}/redirect-loop`), /redirects/);
  });

  await t.test('a redirect to a private-network target is blocked, not followed', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    const server = await startFixtureServer();
    t.after(() => server.close());

    await assert.rejects(() => fetchAsText(`${server.url}/redirect-to-private`), /private-network/);
  });

  await t.test('a private, non-loopback target never reaches the jina/crawl4ai tiers', async () => {
    const server = await startFixtureServer();
    t.after(() => server.close());
    process.env.JINA_API_KEY = 'test-jina-key';
    process.env.CRAWL4AI_URL = server.url;

    let jinaCalled = false;
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith('https://r.jina.ai/')) {
        jinaCalled = true;
        return new Response('Title: x\n\nMarkdown Content:\nshould never be reached', {
          status: 200,
        });
      }
      return originalFetch(input as string, init);
    }) as typeof fetch;

    // 10.1.2.3 is RFC 1918 private and not loopback, so it stays blocked
    // even though this suite sets ALEXANDRIA_ALLOW_LOOPBACK=1 above.
    await assert.rejects(() => fetchAsText('http://10.1.2.3/secret'), /private-network/);
    assert.equal(jinaCalled, false, 'jina reader must never be called for a private target');
    assert.equal(
      server.crawlRequests.length,
      0,
      'crawl4ai must never be called for a private target',
    );

    delete process.env.JINA_API_KEY;
    delete process.env.CRAWL4AI_URL;
  });

  await t.test('rejects a response with an honest, oversized Content-Length', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    const server = await startFixtureServer();
    t.after(() => server.close());

    await assert.rejects(() => fetchAsText(`${server.url}/huge-declared`), /5242880-byte cap/);
  });

  await t.test(
    'aborts a streamed response that exceeds the size cap with no Content-Length',
    async () => {
      delete process.env.JINA_API_KEY;
      delete process.env.ALEXANDRIA_JINA_READER;
      delete process.env.CRAWL4AI_URL;
      const server = await startFixtureServer();
      t.after(() => server.close());

      await assert.rejects(
        () => fetchAsText(`${server.url}/huge`),
        /exceeded the 5242880-byte cap/,
      );
    },
  );

  await t.test('the 5 MB cap also applies to the jina reader tier', async () => {
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    process.env.JINA_API_KEY = 'test-jina-key';
    const server = await startFixtureServer();
    t.after(() => server.close());

    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith('https://r.jina.ai/')) {
        // No Content-Length, streamed: exercises the same abort-while-
        // streaming path as tier 1's /huge fixture above, not the
        // fast-reject-on-a-declared-header path.
        const chunk = 'x'.repeat(1024 * 1024);
        const stream = new ReadableStream({
          start(controller) {
            for (let i = 0; i < 6; i++) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return originalFetch(input as string, init);
    }) as typeof fetch;

    await assert.rejects(
      () => fetchAsText(`${server.url}/tiny`),
      /jina: response for .* exceeded the 5242880-byte cap/,
    );

    delete process.env.JINA_API_KEY;
  });

  await t.test('the 5 MB cap also applies to the crawl4ai tier', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    const server = await startFixtureServer(undefined, true);
    t.after(() => server.close());
    process.env.CRAWL4AI_URL = server.url;

    await assert.rejects(
      () => fetchAsText(`${server.url}/tiny`),
      /crawl4ai: response for .* exceeded the 5242880-byte cap/,
    );

    delete process.env.CRAWL4AI_URL;
  });
});
