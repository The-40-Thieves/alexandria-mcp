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

function registerStaticSource(name: string): void {
  register(name, {
    description: `test static source ${name}`,
    supportsIngest: true,
    freshness: 'static',
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

  await t.test('respects a custom ALEXANDRIA_CORPUS_MIN_SIM', async () => {
    process.env.SUPABASE_URL = 'https://fake.supabase.test';
    process.env.ALEXANDRIA_CORPUS_MIN_SIM = '0.99';
    registerStaticSource('zzfcorpus_static2');

    const store = new FakeStore([
      hit({ similarity: 0.95, metadata: chunkMetadata({ source: 'zzfcorpus_static2' }) }),
    ]);

    const results = await corpusSearch('a query', { store, embed: async () => [[1, 2, 3]] });
    assert.deepEqual(results, [], '0.95 similarity does not clear a 0.99 threshold');
  });
});
