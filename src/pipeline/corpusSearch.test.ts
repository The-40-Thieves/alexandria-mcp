import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../sources/registry.ts';
import type { ChunkMetadata, VectorQueryHit, VectorStoreProvider } from '../types.ts';
import { corpusSearch } from './corpusSearch.ts';

function chunkMetadata(overrides: Partial<ChunkMetadata> = {}): ChunkMetadata {
  return {
    source: 'zzfcorpus_static',
    sourceId: 'doc1',
    title: 'A Cached Document',
    authors: ['A. Author'],
    chunkIndex: 0,
    totalChunks: 1,
    qualityScore: 1,
    ...overrides,
  };
}

function hit(overrides: Partial<VectorQueryHit> = {}): VectorQueryHit {
  const metadata = chunkMetadata(overrides.metadata);
  return {
    id: '1',
    source: metadata.source,
    sourceId: metadata.sourceId,
    chunkIndex: metadata.chunkIndex,
    text: 'The cached chunk text.',
    similarity: 0.95,
    metadata,
    ...overrides,
  };
}

class FakeStore implements VectorStoreProvider {
  calls: Array<{ embedding: number[]; k: number; filter?: { sources?: string[] } }> = [];
  private hits: VectorQueryHit[];
  constructor(hits: VectorQueryHit[]) {
    this.hits = hits;
  }
  async upsert(): Promise<number> {
    return 0;
  }
  async isDuplicate(): Promise<boolean> {
    return false;
  }
  async query(
    embedding: number[],
    k: number,
    filter?: { sources?: string[] },
  ): Promise<VectorQueryHit[]> {
    this.calls.push({ embedding, k, filter });
    return this.hits;
  }
}

function registerStaticSource(
  name: string,
  overrides: { homepage?: string; cluster?: 'science' | 'literature' } = {},
): void {
  register(name, {
    description: `test static source ${name}`,
    supportsIngest: true,
    freshness: 'static',
    homepage: overrides.homepage,
    cluster: overrides.cluster,
    async search() {
      return [];
    },
    async read() {
      return { title: name, authors: [] };
    },
  });
}

// Final wave (E3): a source whose terms forbid storing its text (trove is
// the live example: registered `daily` AND `ingestPolicy: 'forbidden'`),
// and one whose text may only be kept for a retention window.
function registerPolicySource(name: string, ingestPolicy: 'forbidden' | 'timeboxed'): void {
  register(name, {
    description: `test ${ingestPolicy} source ${name}`,
    supportsIngest: true,
    freshness: 'daily',
    ingestPolicy,
    async search() {
      return [];
    },
    async read() {
      return { title: name, authors: [] };
    },
  });
}

function registerRealtimeSource(name: string): void {
  register(name, {
    description: `test realtime source ${name}`,
    supportsIngest: true,
    freshness: 'realtime',
    async search() {
      return [];
    },
    async read() {
      return { title: name, authors: [] };
    },
  });
}

test('corpusSearch', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('returns [] without calling anything when SUPABASE_URL is unset', async () => {
    delete process.env.SUPABASE_URL;
    const store = new FakeStore([hit()]);
    const embedCalls: string[][] = [];
    const results = await corpusSearch('a query', {
      store,
      embed: async (texts) => {
        embedCalls.push(texts);
        return texts.map(() => [0, 0, 0]);
      },
    });
    assert.deepEqual(results, []);
    assert.equal(store.calls.length, 0);
    assert.equal(embedCalls.length, 0);
  });

  await t.test(
    'returns [] without calling the store when no registered source is static/daily',
    async () => {
      process.env.SUPABASE_URL = 'https://fake.supabase.test';
      registerRealtimeSource('zzfcorpus_realtime_only');
      const store = new FakeStore([hit()]);
      const results = await corpusSearch('a query', {
        store,
        embed: async (texts) => texts.map(() => [0, 0, 0]),
      });
      assert.deepEqual(results, []);
      assert.equal(store.calls.length, 0, 'the store is never queried');
    },
  );

  await t.test(
    'folds a hit above the similarity threshold from a static/daily source into a LibraryResult',
    async () => {
      process.env.SUPABASE_URL = 'https://fake.supabase.test';
      registerStaticSource('zzfcorpus_static');
      registerRealtimeSource('zzfcorpus_realtime');

      const staticHit = hit({
        similarity: 0.95,
        metadata: chunkMetadata({ source: 'zzfcorpus_static', sourceId: 'doc1', chunkIndex: 2 }),
      });
      const belowThreshold = hit({
        similarity: 0.5,
        metadata: chunkMetadata({ source: 'zzfcorpus_static', sourceId: 'doc2', chunkIndex: 0 }),
      });
      const realtimeHit = hit({
        similarity: 0.99,
        metadata: chunkMetadata({ source: 'zzfcorpus_realtime', sourceId: 'doc3', chunkIndex: 0 }),
      });
      const store = new FakeStore([staticHit, belowThreshold, realtimeHit]);

      const results = await corpusSearch('a query', {
        store,
        embed: async () => [[1, 2, 3]],
      });

      assert.equal(results.length, 1, 'only the above-threshold static-source hit survives');
      const [r] = results;
      assert.equal(r.source, 'corpus');
      assert.equal(r.id, 'zzfcorpus_static:doc1:2');
      assert.equal(r.hasFullText, true);
      assert.equal(r.fullText, staticHit.text);
      assert.equal(r.title, 'A Cached Document');
      assert.deepEqual(r.authors, ['A. Author']);

      assert.equal(store.calls.length, 1);
      assert.deepEqual(
        store.calls[0].filter?.sources?.sort(),
        ['zzfcorpus_static'],
        'the query is scoped to static/daily sources only, excluding the realtime one',
      );
    },
  );

  await t.test('respects a custom ALEXANDRIA_CORPUS_MIN_SIM', async (t) => {
    process.env.SUPABASE_URL = 'https://fake.supabase.test';
    process.env.ALEXANDRIA_CORPUS_MIN_SIM = '0.99';
    t.after(() => {
      delete process.env.ALEXANDRIA_CORPUS_MIN_SIM;
    });
    registerStaticSource('zzfcorpus_static2');

    const store = new FakeStore([
      hit({ similarity: 0.95, metadata: chunkMetadata({ source: 'zzfcorpus_static2' }) }),
    ]);

    const results = await corpusSearch('a query', { store, embed: async () => [[1, 2, 3]] });
    assert.deepEqual(results, [], '0.95 similarity does not clear a 0.99 threshold');
  });

  // Review round 1 (Important 1): a corpus citation needs a URL and the
  // real registry cluster, or it silently defaults the citation grader's
  // tier and carries no link.
  await t.test('sets url and cluster from the chunk metadata when present', async () => {
    process.env.SUPABASE_URL = 'https://fake.supabase.test';
    registerStaticSource('zzfcorpus_url', { homepage: 'https://registry.test/homepage' });

    const store = new FakeStore([
      hit({
        metadata: chunkMetadata({
          source: 'zzfcorpus_url',
          url: 'https://example.test/stamped-doc',
          cluster: 'science',
        }),
      }),
    ]);

    const [r] = await corpusSearch('a query', { store, embed: async () => [[1, 2, 3]] });
    assert.equal(r.url, 'https://example.test/stamped-doc', 'the stamped url wins');
    assert.equal(r.cluster, 'science');
  });

  await t.test(
    'falls back to the registry homepage/cluster for a chunk with no stamped url/cluster',
    async () => {
      process.env.SUPABASE_URL = 'https://fake.supabase.test';
      registerStaticSource('zzfcorpus_no_url', {
        homepage: 'https://registry.test/fallback',
        cluster: 'literature',
      });

      const store = new FakeStore([
        // No url/cluster in metadata - simulates a chunk ingested before
        // ChunkMetadata gained those fields.
        hit({ metadata: chunkMetadata({ source: 'zzfcorpus_no_url' }) }),
      ]);

      const [r] = await corpusSearch('a query', { store, embed: async () => [[1, 2, 3]] });
      assert.equal(r.url, 'https://registry.test/fallback');
      assert.equal(r.cluster, 'literature');
    },
  );

  // Review round 1 (Important 2): a timeboxed ingest's expiresAt must be
  // honored on the read path, not just enforced at write time.
  await t.test('drops a hit whose metadata.expiresAt is in the past', async () => {
    process.env.SUPABASE_URL = 'https://fake.supabase.test';
    registerStaticSource('zzfcorpus_expiry');

    const expired = hit({
      metadata: chunkMetadata({
        source: 'zzfcorpus_expiry',
        sourceId: 'expired-doc',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    });
    const live = hit({
      metadata: chunkMetadata({
        source: 'zzfcorpus_expiry',
        sourceId: 'live-doc',
        expiresAt: '2999-01-01T00:00:00.000Z',
      }),
    });
    const noExpiry = hit({
      metadata: chunkMetadata({ source: 'zzfcorpus_expiry', sourceId: 'no-expiry-doc' }),
    });
    const store = new FakeStore([expired, live, noExpiry]);

    const results = await corpusSearch('a query', { store, embed: async () => [[1, 2, 3]] });

    const ids = results.map((r) => r.id).sort();
    assert.deepEqual(ids, ['zzfcorpus_expiry:live-doc:0', 'zzfcorpus_expiry:no-expiry-doc:0']);
  });

  // Minor 2: the gate is "SUPABASE_URL set AND an embeddings role
  // configured" - either alone is not enough.
  await t.test(
    'returns [] without calling the store or embed when no embeddings role is configured',
    async () => {
      process.env.SUPABASE_URL = 'https://fake.supabase.test';
      delete process.env.OPENAI_API_KEY;
      delete process.env.ALEXANDRIA_API_KEY;
      delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
      registerStaticSource('zzfcorpus_no_embeddings');

      const store = new FakeStore([
        hit({ metadata: chunkMetadata({ source: 'zzfcorpus_no_embeddings' }) }),
      ]);

      // No `embed` override passed - corpusSearch must fall back to
      // hasEmbeddingsConfigured() and bail before ever calling the real
      // embed() or the store.
      const results = await corpusSearch('a query', { store });

      assert.deepEqual(results, []);
      assert.equal(store.calls.length, 0, 'the store is never queried');
    },
  );
});

// Final wave (E3): cacheableSources() filtered on freshness alone, and
// freshness has nothing to do with whether a source's terms allow storing
// its text. A pre-policy or externally inserted chunk from a `forbidden`
// source (trove is registered daily AND forbidden) was returned, embedded
// into answers, and cited. And a `timeboxed` chunk with no expiresAt was
// treated as never expiring, which is the opposite of a retention window.
test('corpusSearch: ingest policy is enforced on the read path', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });
  process.env.SUPABASE_URL = 'https://fake.supabase.test';

  registerStaticSource('zzfcorpus_policy_ok');
  registerPolicySource('zzfcorpus_policy_forbidden', 'forbidden');
  registerPolicySource('zzfcorpus_policy_timeboxed', 'timeboxed');

  const embed = async (texts: string[]) => texts.map(() => [0, 0, 0]);

  await t.test('a forbidden source is excluded from the query filter', async () => {
    const store = new FakeStore([]);
    await corpusSearch('a query', { store, embed });
    const sources = store.calls[0]?.filter?.sources ?? [];
    assert.ok(sources.includes('zzfcorpus_policy_ok'));
    assert.ok(
      !sources.includes('zzfcorpus_policy_forbidden'),
      'a forbidden source must never enter the query filter',
    );
  });

  await t.test('a forbidden chunk the store returns anyway is dropped', async () => {
    // A provider that ignores the filter (or a chunk written before the
    // policy existed) must still not reach an answer.
    const store = new FakeStore([
      hit({
        metadata: chunkMetadata({ source: 'zzfcorpus_policy_forbidden', sourceId: 'trove-doc' }),
        source: 'zzfcorpus_policy_forbidden',
      }),
      hit({
        metadata: chunkMetadata({ source: 'zzfcorpus_policy_ok', sourceId: 'ok-doc' }),
        source: 'zzfcorpus_policy_ok',
      }),
    ]);
    const results = await corpusSearch('a query', { store, embed });
    assert.deepEqual(
      results.map((r) => r.id),
      ['zzfcorpus_policy_ok:ok-doc:0'],
    );
  });

  await t.test('a timeboxed chunk with no expiresAt is dropped', async () => {
    const store = new FakeStore([
      hit({
        metadata: chunkMetadata({ source: 'zzfcorpus_policy_timeboxed', sourceId: 'news-doc' }),
        source: 'zzfcorpus_policy_timeboxed',
      }),
    ]);
    assert.deepEqual(await corpusSearch('a query', { store, embed }), []);
  });

  await t.test('a timeboxed chunk with a malformed expiresAt is dropped', async () => {
    const store = new FakeStore([
      hit({
        metadata: chunkMetadata({
          source: 'zzfcorpus_policy_timeboxed',
          sourceId: 'news-doc',
          expiresAt: 'not-a-date',
        }),
        source: 'zzfcorpus_policy_timeboxed',
      }),
    ]);
    assert.deepEqual(await corpusSearch('a query', { store, embed }), []);
  });

  await t.test('a timeboxed chunk with a valid future expiresAt is served', async () => {
    const store = new FakeStore([
      hit({
        metadata: chunkMetadata({
          source: 'zzfcorpus_policy_timeboxed',
          sourceId: 'news-doc',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        source: 'zzfcorpus_policy_timeboxed',
      }),
    ]);
    const results = await corpusSearch('a query', { store, embed });
    assert.deepEqual(
      results.map((r) => r.id),
      ['zzfcorpus_policy_timeboxed:news-doc:0'],
    );
  });
});
