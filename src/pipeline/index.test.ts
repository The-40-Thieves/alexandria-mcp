import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIngestAllowed, ingestMetadata } from '../sources/ingestPolicy.ts';
import type { Chunk, EmbeddingProvider, VectorStoreProvider } from '../types.ts';
import { ingestText } from './index.ts';

// A paragraph of clean ASCII prose, long enough (and well above the
// quality threshold) to survive chunkSemantic()/filterChunks() unscathed.
const LONG_TEXT =
  'The quick brown fox jumps over the lazy dog near the riverbank every single morning before ' +
  'the sun has fully risen above the eastern hills, and the villagers who wake early enough to ' +
  'see it always remark on how gracefully it moves through the tall grass without a sound.';

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0]);
  }
}

class FakeVectorStore implements VectorStoreProvider {
  lastChunks: Chunk[] = [];
  lastMcpName = '';
  async upsert(chunks: Chunk[], _embeddings: number[][], mcpName: string): Promise<number> {
    this.lastChunks = chunks;
    this.lastMcpName = mcpName;
    return chunks.length;
  }
  async isDuplicate(): Promise<boolean> {
    return false;
  }
}

// Mirrors the sequence src/index.ts's library_ingest handler runs: refuse
// via assertIngestAllowed before ever touching the pipeline, or compute
// ingestMetadata()'s stamp and hand it to ingestText() so it lands on
// every written chunk. A fake embedder/store stands in for OpenAI/Supabase
// so this never reaches a live endpoint.
test('library_ingest flow: refusal and stamped chunk metadata', async (t) => {
  await t.test('forbidden policy refuses before any chunking happens', () => {
    assert.throws(
      () => assertIngestAllowed({ name: 'trove', ingestPolicy: 'forbidden' }),
      /"trove" cannot be ingested/,
    );
  });

  await t.test('timeboxed policy refuses without ALEXANDRIA_INGEST_TIMEBOXED=1', (t) => {
    const original = process.env.ALEXANDRIA_INGEST_TIMEBOXED;
    delete process.env.ALEXANDRIA_INGEST_TIMEBOXED;
    t.after(() => {
      if (original === undefined) delete process.env.ALEXANDRIA_INGEST_TIMEBOXED;
      else process.env.ALEXANDRIA_INGEST_TIMEBOXED = original;
    });
    assert.throws(
      () => assertIngestAllowed({ name: 'guardian', ingestPolicy: 'timeboxed' }),
      /"guardian" ingest is timeboxed/,
    );
  });

  await t.test('attribution policy: every written chunk is stamped with attribution', async () => {
    const store = new FakeVectorStore();
    const embedder = new FakeEmbeddingProvider();
    const chunkStamp = ingestMetadata({
      name: 'semanticscholar',
      ingestPolicy: 'attribution',
      homepage: 'https://www.semanticscholar.org',
    });

    const result = await ingestText(
      LONG_TEXT,
      'semanticscholar',
      'paper1',
      'A Test Paper',
      ['A. Author'],
      2020,
      'en',
      chunkStamp,
      { embedder, store },
    );

    assert.equal(result.chunksWritten, 1);
    assert.ok(store.lastChunks.length > 0, 'the fake store received the written chunks');
    for (const chunk of store.lastChunks) {
      assert.equal(chunk.metadata.attribution, 'semanticscholar (https://www.semanticscholar.org)');
      assert.equal(chunk.metadata.expiresAt, undefined);
    }
  });

  await t.test(
    'timeboxed policy (opted in): every written chunk is stamped with an expiry',
    async () => {
      const original = process.env.ALEXANDRIA_INGEST_TIMEBOXED;
      process.env.ALEXANDRIA_INGEST_TIMEBOXED = '1';
      t.after(() => {
        if (original === undefined) delete process.env.ALEXANDRIA_INGEST_TIMEBOXED;
        else process.env.ALEXANDRIA_INGEST_TIMEBOXED = original;
      });
      assert.doesNotThrow(() =>
        assertIngestAllowed({ name: 'guardian', ingestPolicy: 'timeboxed' }),
      );

      const store = new FakeVectorStore();
      const embedder = new FakeEmbeddingProvider();
      const chunkStamp = ingestMetadata({ name: 'guardian', ingestPolicy: 'timeboxed' });

      await ingestText(
        LONG_TEXT,
        'guardian',
        'article1',
        'A Test Article',
        [],
        2026,
        'en',
        chunkStamp,
        { embedder, store },
      );

      assert.ok(store.lastChunks.length > 0);
      for (const chunk of store.lastChunks) {
        assert.ok(chunk.metadata.expiresAt, 'expiresAt is stamped');
        assert.equal(chunk.metadata.attribution, undefined);
      }
    },
  );

  await t.test('allowed policy: no chunk stamp at all (chunkStamp is undefined)', async () => {
    const store = new FakeVectorStore();
    const embedder = new FakeEmbeddingProvider();

    await ingestText(
      LONG_TEXT,
      'gutenberg',
      'book1',
      'A Test Book',
      ['Author'],
      1900,
      'en',
      undefined,
      { embedder, store },
    );
    for (const chunk of store.lastChunks) {
      assert.equal(chunk.metadata.attribution, undefined);
      assert.equal(chunk.metadata.expiresAt, undefined);
      assert.equal(chunk.metadata.license, undefined);
    }
  });
});
