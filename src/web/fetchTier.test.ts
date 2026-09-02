import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { assertFetchableUrl, fetchAsText } from './fetchTier.js';

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
// force tier 2/3 selection), /broken (a 500), and /crawl (a stand-in for a
// crawl4ai server, when CRAWL4AI_URL is pointed at this server).
function startFixtureServer(crawlResponse?: unknown): Promise<FixtureServer> {
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
      if (req.method === 'POST' && req.url === '/crawl') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          crawlRequests.push(JSON.parse(body || '{}'));
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
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('rejects a non-http(s) URL', () => {
    assert.throws(() => assertFetchableUrl('file:///etc/passwd'), /non-http/);
  });

  await t.test('rejects an unparseable URL', () => {
    assert.throws(() => assertFetchableUrl('not a url'), /not a valid URL/);
  });

  await t.test('rejects localhost by default', () => {
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
    assert.throws(() => assertFetchableUrl('http://localhost:8080/x'), /loopback/);
  });

  await t.test('rejects 127.0.0.1 by default', () => {
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
    assert.throws(() => assertFetchableUrl('http://127.0.0.1:8080/x'), /loopback/);
  });

  await t.test('allows loopback when ALEXANDRIA_ALLOW_LOOPBACK=1', () => {
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    assert.doesNotThrow(() => assertFetchableUrl('http://127.0.0.1:8080/x'));
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
  });

  await t.test('rejects RFC 1918 and link-local ranges with no override', () => {
    for (const host of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1']) {
      assert.throws(() => assertFetchableUrl(`http://${host}/x`), /private-network/, host);
    }
    process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
    assert.throws(() => assertFetchableUrl('http://10.1.2.3/x'), /private-network/);
    delete process.env.ALEXANDRIA_ALLOW_LOOPBACK;
  });

  await t.test('rejects .internal and .local hostnames', () => {
    assert.throws(() => assertFetchableUrl('http://box.internal/x'), /private-network/);
    assert.throws(() => assertFetchableUrl('http://printer.local/x'), /private-network/);
  });

  await t.test('allows a configured CRAWL4AI_URL/SEARXNG_URL host regardless of range', () => {
    process.env.CRAWL4AI_URL = 'http://100.78.123.100:11235';
    process.env.SEARXNG_URL = 'http://192.168.1.50:8888';
    assert.doesNotThrow(() => assertFetchableUrl('http://100.78.123.100:11235/health'));
    assert.doesNotThrow(() => assertFetchableUrl('http://192.168.1.50:8888/search'));
  });

  await t.test('allows an ordinary public https URL', () => {
    assert.doesNotThrow(() => assertFetchableUrl('https://example.com/article'));
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
});
