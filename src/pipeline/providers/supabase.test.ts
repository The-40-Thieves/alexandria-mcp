import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChunkMetadata } from '../../types.ts';
import { SupabaseVectorStoreProvider } from './supabase.ts';

// A minimal stand-in for supabase-js's real client: only `.rpc()` is
// exercised by query(), so that's all a fake needs to implement. Cast
// through `unknown` rather than fighting the real client's generic type.
function fakeClient(
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

function metadata(overrides: Partial<ChunkMetadata> = {}): ChunkMetadata {
  return {
    source: 'zzfsupabase_test',
    sourceId: 'doc1',
    title: 'A Title',
    authors: [],
    chunkIndex: 0,
    totalChunks: 1,
    qualityScore: 1,
    ...overrides,
  };
}

test('SupabaseVectorStoreProvider', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });
  process.env.SUPABASE_URL = 'https://fake.supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key';

  await t.test('throws without SUPABASE_URL rather than reaching the network', () => {
    delete process.env.SUPABASE_URL;
    assert.throws(() => new SupabaseVectorStoreProvider(), /SUPABASE_URL is not set/);
    process.env.SUPABASE_URL = 'https://fake.supabase.test';
  });

  await t.test(
    'query() calls match_knowledge_chunks with sources: null when no filter is given',
    async () => {
      let calledWith: { fn: string; args: Record<string, unknown> } | undefined;
      const provider = new SupabaseVectorStoreProvider(
        fakeClient(async (fn, args) => {
          calledWith = { fn, args };
          return { data: [], error: null };
        }),
      );

      const results = await provider.query([1, 2, 3], 5);

      assert.equal(calledWith?.fn, 'match_knowledge_chunks');
      assert.deepEqual(calledWith?.args, {
        query_embedding: [1, 2, 3],
        match_count: 5,
        min_similarity: 0,
        sources: null,
      });
      assert.deepEqual(results, []);
    },
  );

  await t.test(
    'query() passes an empty sources array through unchanged, not coerced to null',
    async () => {
      // Review round 1 (Important 3): an empty array and an omitted filter
      // must both reach the RPC call, and match_knowledge_chunks.sql
      // treats both as "no filter" - this pins the TS side of that
      // contract so a future edit can't silently start converting `[]`
      // into `null` (which would happen to work the same way against this
      // SQL, but would break the "empty means no filter" doc contract).
      let calledWith: Record<string, unknown> | undefined;
      const provider = new SupabaseVectorStoreProvider(
        fakeClient(async (_fn, args) => {
          calledWith = args;
          return { data: [], error: null };
        }),
      );

      await provider.query([1, 2, 3], 5, { sources: [] });

      assert.deepEqual(calledWith?.sources, []);
    },
  );

  await t.test('query() passes a non-empty sources filter through', async () => {
    let calledWith: Record<string, unknown> | undefined;
    const provider = new SupabaseVectorStoreProvider(
      fakeClient(async (_fn, args) => {
        calledWith = args;
        return { data: [], error: null };
      }),
    );

    await provider.query([1, 2, 3], 5, { sources: ['arxiv', 'gutenberg'] });

    assert.deepEqual(calledWith?.sources, ['arxiv', 'gutenberg']);
  });

  await t.test('query() maps a returned row into a VectorQueryHit', async () => {
    const rowMetadata = metadata({ source: 'arxiv', sourceId: 'paper1', chunkIndex: 2 });
    const provider = new SupabaseVectorStoreProvider(
      fakeClient(async () => ({
        data: [
          {
            id: 42,
            source: 'arxiv',
            source_id: 'paper1',
            chunk_index: 2,
            content: 'chunk text',
            similarity: 0.97,
            metadata: rowMetadata,
          },
        ],
        error: null,
      })),
    );

    const [hit] = await provider.query([1, 2, 3], 5);

    assert.deepEqual(hit, {
      id: '42',
      source: 'arxiv',
      sourceId: 'paper1',
      chunkIndex: 2,
      text: 'chunk text',
      similarity: 0.97,
      metadata: rowMetadata,
    });
  });

  await t.test('query() throws with the rpc error message on failure', async () => {
    const provider = new SupabaseVectorStoreProvider(
      fakeClient(async () => ({ data: null, error: { message: 'boom' } })),
    );

    await assert.rejects(() => provider.query([1, 2, 3], 5), /match_knowledge_chunks failed: boom/);
  });
});
