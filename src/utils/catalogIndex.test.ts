import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../sources/all.js';
import { listSources } from '../sources/registry.js';
import {
  bm25Candidates,
  buildCatalog,
  type CatalogEntry,
  candidates,
  resetCatalogCacheForTests,
} from './catalogIndex.js';

function synthetic(overrides: Partial<CatalogEntry> & Pick<CatalogEntry, 'name'>): CatalogEntry {
  return {
    text: `${overrides.name}: a source`,
    cluster: 'literature',
    freshness: 'static',
    ...overrides,
  };
}

interface FakeEmbeddingServer {
  url: string;
  embedCalls: number;
  close(): Promise<void>;
}

function toBase64Float32(nums: number[]): string {
  const buf = Buffer.alloc(nums.length * 4);
  nums.forEach((n, i) => {
    buf.writeFloatLE(n, i * 4);
  });
  return buf.toString('base64');
}

// A fake OpenAI-compatible /v1/embeddings endpoint. Assigns every input text
// a deterministic vector derived from a simple hash of the text, so the
// same text always embeds to the same vector across calls (needed for the
// disk-cache re-hit test) while different texts get different vectors
// (needed for the cosine-ranking test to be meaningful).
function startFakeEmbeddingServer(): Promise<FakeEmbeddingServer> {
  let embedCalls = 0;
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        embedCalls += 1;
        const body = raw ? JSON.parse(raw) : {};
        const input = (body.input as string[]) ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: input.map((text: string, i: number) => {
              let hash = 0;
              for (let j = 0; j < text.length; j++) hash = (hash * 31 + text.charCodeAt(j)) % 997;
              return { embedding: toBase64Float32([hash, hash % 13, hash % 7]), index: i };
            }),
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        get embedCalls() {
          return embedCalls;
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test('bm25Candidates', async (t) => {
  const pool: CatalogEntry[] = [
    synthetic({
      name: 'arxiv',
      text: 'arxiv: preprint server for physics, math, and computer science papers (cluster academic)',
      cluster: 'academic',
    }),
    synthetic({
      name: 'gutenberg',
      text: 'gutenberg: public domain ebooks and classic literature (cluster literature)',
      cluster: 'literature',
    }),
    synthetic({
      name: 'kev',
      text: 'kev: CISA known exploited vulnerabilities catalog, CVE advisories (cluster security)',
      cluster: 'security',
    }),
  ];

  await t.test('ranks the source whose description overlaps the query terms highest', () => {
    const ranked = bm25Candidates('physics preprint papers', pool, 3);
    assert.equal(ranked[0].name, 'arxiv');
  });

  await t.test('a cluster-keyword match boosts that cluster even with weak term overlap', () => {
    const ranked = bm25Candidates('CVE exploitation status', pool, 3);
    assert.equal(ranked[0].name, 'kev');
  });

  await t.test('k caps the returned list', () => {
    assert.equal(bm25Candidates('books', pool, 1).length, 1);
  });

  await t.test('an empty entries list returns []', () => {
    assert.deepEqual(bm25Candidates('anything', [], 5), []);
  });
});

test('candidates', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    resetCatalogCacheForTests();
  });

  await t.test('always includes every entry of the top-scoring cluster, up to k', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
    delete process.env.ALEXANDRIA_API_KEY;
    resetCatalogCacheForTests();

    const pool: CatalogEntry[] = [
      synthetic({
        name: 'a1',
        text: 'a1: astronomy telescope observatory (cluster science)',
        cluster: 'science',
      }),
      synthetic({
        name: 'a2',
        text: 'a2: astronomy star catalog data (cluster science)',
        cluster: 'science',
      }),
      synthetic({
        name: 'a3',
        text: 'a3: astronomy exoplanet survey (cluster science)',
        cluster: 'science',
      }),
      synthetic({
        name: 'b1',
        text: 'b1: cooking recipes (cluster literature)',
        cluster: 'literature',
      }),
    ];
    const ranked = bm25Candidates('astronomy telescope', pool, 4);
    assert.equal(ranked[0].cluster, 'science');

    // withClusterFloor is exercised indirectly through candidates(), which
    // wraps whichever ranker (bm25 here, no embeddings configured) with the
    // cluster-floor guarantee. Feed the ranker's own pool through the
    // module-internal helper by calling candidates() with a real (registry)
    // catalog instead: assert the invariant on the actual catalog, where
    // the "science" cluster has more than one member.
    const real = await candidates('astronomy telescope observatory', 3);
    const scienceInPool = (await buildCatalog()).filter((e) => e.cluster === real[0]?.cluster);
    const scienceInResult = real.filter((e) => e.cluster === real[0]?.cluster);
    assert.equal(
      scienceInResult.length,
      Math.min(scienceInPool.length, 3),
      'every top-cluster entry should appear, capped at k',
    );
  });

  await t.test(
    'falls back to bm25 with no network calls when no embeddings are configured',
    async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
      delete process.env.ALEXANDRIA_API_KEY;
      resetCatalogCacheForTests();

      const result = await candidates('public domain books', 5);
      assert.ok(result.length > 0);
      assert.ok(result.every((e) => e.vector === undefined));
    },
  );

  await t.test('uses cosine ranking and persists embeddings when configured', async () => {
    const server = await startFakeEmbeddingServer();
    t.after(() => server.close());

    const cacheDir = mkdtempSync(path.join(tmpdir(), 'alexandria-catalog-cache-'));
    const cachePath = path.join(cacheDir, 'catalog-embeddings.json');
    t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

    process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL = server.url;
    process.env.ALEXANDRIA_EMBEDDINGS_API_KEY = 'test-key';
    process.env.ALEXANDRIA_CATALOG_CACHE_PATH = cachePath;
    resetCatalogCacheForTests();

    const first = await buildCatalog();
    assert.ok(first.length > 0);
    assert.ok(
      first.every((e) => e.vector !== undefined),
      'every entry should have a vector',
    );
    const callsAfterFirstBuild = server.embedCalls;
    assert.ok(callsAfterFirstBuild > 0);

    // A second build within the same process hits the in-memory cache, not
    // the network at all.
    const second = await buildCatalog();
    assert.equal(second, first);
    assert.equal(server.embedCalls, callsAfterFirstBuild);

    // A fresh "process" (in-memory cache cleared) reads the disk cache
    // instead of re-embedding every source.
    resetCatalogCacheForTests();
    const third = await buildCatalog();
    assert.equal(third.length, first.length);
    assert.equal(
      server.embedCalls,
      callsAfterFirstBuild,
      'restart should not re-embed unchanged text',
    );

    const ranked = await candidates('public domain books', 5);
    assert.ok(ranked.length > 0);

    delete process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL;
    delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
    delete process.env.ALEXANDRIA_CATALOG_CACHE_PATH;
  });
});

test('buildCatalog matches the registry catalog', async () => {
  resetCatalogCacheForTests();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;
  const entries = await buildCatalog();
  const names = new Set(entries.map((e) => e.name));
  const registryNames = new Set(
    listSources()
      .filter((s) => !s.hidden)
      .map((s) => s.name),
  );
  assert.deepEqual(names, registryNames);
  resetCatalogCacheForTests();
});
