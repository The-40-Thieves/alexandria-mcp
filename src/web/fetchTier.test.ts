import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test, { after } from 'node:test';
import { guardedDispatcher, withPinnedAddress } from '../utils/dispatcher.ts';
import { fetchWithRetry } from '../utils/http.ts';
import { VERSION } from '../version.ts';
import { resetExtractWorkerForTests } from './extract.ts';
import {
  assertConfiguredServiceUrl,
  assertFetchableUrl,
  type DnsLookupAll,
  dnsResolver,
  fetchAsText,
} from './fetchTier.ts';

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), 'eval/fixtures/web', name), 'utf8');
}

// The same hand-built, two-page PDF pdf.test.ts exercises directly (see
// scripts/gen-pdf-fixture.ts) - reused here to drive fetchAsText's PDF
// branch end to end through a real HTTP response.
function samplePdfBytes(): Buffer {
  return readFileSync(path.resolve(process.cwd(), 'eval/fixtures/sample.pdf'));
}

interface FixtureServer {
  url: string;
  crawlRequests: unknown[];
  // Task 13: every /article request's incoming headers, in order - lets a
  // test assert what User-Agent/Accept tryDefuddle actually sent without
  // adding a dedicated echo endpoint that would need its own content-type
  // branch in tryDefuddle to be readable back.
  articleRequestHeaders: IncomingMessage['headers'][];
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
// streaming size cap), /huge-declared (a 6 MB body with an honest,
// oversized Content-Length, to exercise the fast-reject path), and
// /markdown (task 13: a text/markdown response, to exercise the markdown
// hop bypassing extraction). `hugeCrawl` makes /crawl itself stream an
// oversized chunked body instead of its normal JSON, to exercise the same
// streaming size cap on tier 3.
function startFixtureServer(crawlResponse?: unknown, hugeCrawl = false): Promise<FixtureServer> {
  const crawlRequests: unknown[] = [];
  const articleRequestHeaders: IncomingMessage['headers'][] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/article') {
        articleRequestHeaders.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fixture('article.html'));
        return;
      }
      if (req.method === 'GET' && req.url === '/markdown') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end('# Agent-Ready Markdown\n\nThis body is used as-is, no extraction involved.');
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
      if (req.method === 'GET' && req.url === '/sample.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(samplePdfBytes());
        return;
      }
      if (req.method === 'GET' && req.url === '/octet.pdf') {
        // Some OA hosts serve a PDF with a generic content-type; the .pdf
        // path is what tryDefuddle's isPdf check falls back to.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(samplePdfBytes());
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
        articleRequestHeaders,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// Task 13: tier 1 now runs extraction on a lazily-started worker thread
// (see extract.ts), and more than one test below extracts real article
// HTML - a worker keeps the process alive on its own once started, so a
// per-test t.after() covering only one of those tests isn't enough: the
// process would still hang after whichever one runs last. A single
// file-level after() runs once, after every test in this file, and covers
// all of them regardless of which one happened to start the worker.
after(() => resetExtractWorkerForTests());

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

  // Final wave, A12: classifyIpLiteral() returns null both for "not a
  // literal IP at all" and for "a literal IP that isn't restricted" (a
  // genuine public address) - resolveFetchTarget() used to treat that null
  // as "not a literal, go resolve it", so a public IPv6 literal fell
  // through to dnsResolver.lookup(parsed.hostname, ...) with the host
  // still bracketed. isIpLiteral() answers "is this a literal IP at all"
  // separately, so this must be allowed AND must never reach the resolver.
  await t.test('allows a public IPv6 literal and never calls the resolver for it', async () => {
    let lookupCalls = 0;
    dnsResolver.lookup = (async () => {
      lookupCalls++;
      return [{ address: '93.184.216.34', family: 4 }];
    }) satisfies DnsLookupAll;
    t.after(() => {
      dnsResolver.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) satisfies DnsLookupAll;
    });

    await assert.doesNotReject(() => assertFetchableUrl('https://[2606:4700:4700::1111]/'));
    assert.equal(lookupCalls, 0, 'a literal IP must never reach dnsResolver.lookup');
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

  await t.test('tier 1: sends the honest, version-carrying default User-Agent', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    delete process.env.ALEXANDRIA_FETCH_UA;
    const server = await startFixtureServer();
    t.after(() => server.close());

    await fetchAsText(`${server.url}/article`);
    assert.equal(server.articleRequestHeaders.length, 1);
    assert.equal(
      server.articleRequestHeaders[0]?.['user-agent'],
      `Alexandria/${VERSION} (+https://github.com/The-40-Thieves/alexandria-mcp)`,
    );
  });

  await t.test('tier 1: ALEXANDRIA_FETCH_UA overrides the default User-Agent', async () => {
    delete process.env.JINA_API_KEY;
    delete process.env.ALEXANDRIA_JINA_READER;
    delete process.env.CRAWL4AI_URL;
    process.env.ALEXANDRIA_FETCH_UA = 'CustomBot/1.0 (+https://example.com/bot)';
    const server = await startFixtureServer();
    t.after(() => server.close());

    await fetchAsText(`${server.url}/article`);
    assert.equal(
      server.articleRequestHeaders[0]?.['user-agent'],
      'CustomBot/1.0 (+https://example.com/bot)',
    );
    delete process.env.ALEXANDRIA_FETCH_UA;
  });

  await t.test(
    'tier 1: a text/markdown response (Markdown for Agents) is used as-is, skipping extraction',
    async () => {
      delete process.env.JINA_API_KEY;
      delete process.env.ALEXANDRIA_JINA_READER;
      delete process.env.CRAWL4AI_URL;
      const server = await startFixtureServer();
      t.after(() => server.close());

      const page = await fetchAsText(`${server.url}/markdown`);
      assert.equal(page.via, 'markdown');
      assert.equal(
        page.text,
        '# Agent-Ready Markdown\n\nThis body is used as-is, no extraction involved.',
      );
    },
  );

  await t.test(
    'tier 1: a PDF response (by content-type) is extracted via unpdf, per page',
    async () => {
      delete process.env.JINA_API_KEY;
      delete process.env.ALEXANDRIA_JINA_READER;
      delete process.env.CRAWL4AI_URL;
      const server = await startFixtureServer();
      t.after(() => server.close());

      const page = await fetchAsText(`${server.url}/sample.pdf`);
      assert.equal(page.via, 'pdf');
      assert.equal(page.title, 'Alexandria Fixture PDF');
      assert.equal(
        page.text,
        'Hello from page one of the fixture PDF.\n\nHello from page two of the fixture PDF.',
      );
      assert.deepEqual(page.pages, [
        { page: 1, text: 'Hello from page one of the fixture PDF.' },
        { page: 2, text: 'Hello from page two of the fixture PDF.' },
      ]);
    },
  );

  await t.test(
    'tier 1: a PDF response is recognized by a .pdf URL path even with a generic content-type',
    async () => {
      delete process.env.JINA_API_KEY;
      delete process.env.ALEXANDRIA_JINA_READER;
      delete process.env.CRAWL4AI_URL;
      const server = await startFixtureServer();
      t.after(() => server.close());

      const page = await fetchAsText(`${server.url}/octet.pdf`);
      assert.equal(page.via, 'pdf');
      assert.equal(page.pages?.length, 2);
    },
  );

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

// A local http.Server bound to one specific address:port, tracking how many
// requests it received. Used by the address-pinning test below, which needs
// two servers sharing one port across two different loopback addresses -
// startFixtureServer() above always binds an OS-assigned ephemeral port, so
// it can't produce that pairing.
interface PinnedServer {
  port: number;
  hits: number;
  close(): Promise<void>;
}
function startServerOn(address: string, port: number, body: string): Promise<PinnedServer> {
  const state = { hits: 0 };
  return new Promise((resolve, reject) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      state.hits += 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.once('error', reject);
    server.listen(port, address, () => {
      const bound = server.address();
      const boundPort = typeof bound === 'object' && bound ? bound.port : port;
      resolve({
        port: boundPort,
        get hits() {
          return state.hits;
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test('guardedDispatcher pins the connection to the address the guard validated', async (t) => {
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
  delete process.env.JINA_API_KEY;
  delete process.env.ALEXANDRIA_JINA_READER;
  delete process.env.CRAWL4AI_URL;

  await t.test(
    'a hostname whose DNS answer could change between validation and connect never reaches a later, different address',
    async () => {
      const article = fixture('article.html');
      // "first" is the address assertFetchableUrl/resolveFetchTarget
      // validates (dnsResolver.lookup's 1st call, below) and pins the
      // connection to; "second" stands in for what an independent,
      // un-pinned DNS lookup at connect time would answer with instead
      // (attacker-controlled DNS / rebinding) - every dnsResolver.lookup
      // call after the first returns it. Same port, two different loopback
      // addresses, so the request URL never changes; only which address the
      // connection actually reaches distinguishes the two.
      const first = await startServerOn('127.0.0.1', 0, article);
      t.after(() => first.close());
      const second = await startServerOn('127.0.0.2', first.port, 'should never be reached');
      t.after(() => second.close());

      let lookupCalls = 0;
      dnsResolver.lookup = (async () => {
        lookupCalls += 1;
        return lookupCalls === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '127.0.0.2', family: 4 }];
      }) satisfies DnsLookupAll;

      const page = await fetchAsText(`http://pin-test.invalid:${first.port}/`);

      assert.equal(page.title, 'A Long Enough Article About Testing');
      assert.equal(lookupCalls, 1, 'no second, independent DNS lookup was ever triggered');
      assert.equal(first.hits, 1, 'the connection reached the address the guard validated');
      assert.equal(second.hits, 0, 'the connection never reached the later, different address');
    },
  );

  await t.test('a guarded fetch with no pinned address in scope fails closed', async () => {
    // guardedDispatcher's connect.lookup refuses to connect at all when no
    // pin is in scope for the hostname, rather than silently falling back
    // to an unvalidated system DNS lookup. fetchAsText() always establishes
    // a pin before this path runs (see above), so this exercises the
    // dispatcher's own fail-closed behavior directly.
    const pin = {
      hostname: 'no-pin-for-this-host.invalid',
      addresses: [{ address: '127.0.0.1', family: 4 }],
    };
    await assert.rejects(
      () =>
        withPinnedAddress(pin, () =>
          fetchWithRetry(
            'http://a-different-host.invalid/',
            { dispatcher: guardedDispatcher },
            1000,
            0,
          ),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(String(err.cause), /no pinned address/);
        return true;
      },
    );
  });

  await t.test(
    'a dead first address does not sink the connection: guardedDispatcher falls through to a later, live, validated address',
    async () => {
      // Both addresses were validated by the guard (this is the multi-
      // address happy-eyeballs case, not the TOCTOU case above): the first
      // is a loopback address nothing listens on (a fast, local
      // ECONNREFUSED rather than a slow timeout), the second is a real
      // server. Pre-change, the plain default connector raced/fell through
      // the full dns.lookup(all:true) set; pinning to only the first
      // address regressed that - this proves the pin carries the whole
      // set and Node's own connect failover still works within it.
      const article = fixture('article.html');
      const live = await startServerOn('127.0.0.2', 0, article);
      t.after(() => live.close());

      dnsResolver.lookup = (async () => [
        { address: '127.0.0.3', family: 4 }, // dead: nothing listens here
        { address: '127.0.0.2', family: 4 }, // live: the server above
      ]) satisfies DnsLookupAll;

      const page = await fetchAsText(`http://dead-first-address.invalid:${live.port}/`);
      assert.equal(page.title, 'A Long Enough Article About Testing');
      assert.equal(live.hits, 1);
    },
  );

  await t.test(
    'fetchAsText against localhost still succeeds (localhost is pinned, not left unpinned)',
    async () => {
      const article = fixture('article.html');
      const server = await startServerOn('127.0.0.1', 0, article);
      t.after(() => server.close());

      const page = await fetchAsText(`http://localhost:${server.port}/`);
      assert.equal(page.title, 'A Long Enough Article About Testing');
      assert.equal(server.hits, 1);
    },
  );
});
