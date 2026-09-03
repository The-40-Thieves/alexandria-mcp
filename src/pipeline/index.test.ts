import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIngestAllowed, ingestMetadata } from '../sources/ingestPolicy.ts';
import { register } from '../sources/registry.ts';
import type { Chunk, EmbeddingProvider, VectorQueryHit, VectorStoreProvider } from '../types.ts';
import { chunkSemantic, indexText, ingestText } from './index.ts';

// A paragraph of clean ASCII prose, long enough (and well above the
// quality threshold) to survive chunkSemantic()/filterChunks() unscathed.
const LONG_TEXT =
  'The quick brown fox jumps over the lazy dog near the riverbank every single morning before ' +
  'the sun has fully risen above the eastern hills, and the villagers who wake early enough to ' +
  'see it always remark on how gracefully it moves through the tall grass without a sound.';

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  received: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.received = texts;
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
  // Task 12 added query() to the interface; unused by this ingest-path
  // test, which never searches the store it writes to.
  async query(): Promise<VectorQueryHit[]> {
    return [];
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
      undefined,
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
        undefined,
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
      undefined,
      { embedder, store },
    );
    for (const chunk of store.lastChunks) {
      assert.equal(chunk.metadata.attribution, undefined);
      assert.equal(chunk.metadata.expiresAt, undefined);
      assert.equal(chunk.metadata.license, undefined);
    }
  });

  // Review round 1 (Important 1): every written chunk carries a url (from
  // the caller, e.g. the adapter's ReadResult.externalUrl or its registry
  // homepage - see src/index.ts's library_ingest handler) and a cluster
  // (resolved from the registry, not caller-supplied) so a corpus-as-cache
  // citation later has both a real link and a real grader tier.
  await t.test('every written chunk is stamped with url and the registry cluster', async () => {
    register('zzfingest_stamp_source', {
      description: 'test source for url/cluster stamping',
      supportsIngest: true,
      cluster: 'science',
      async search() {
        return [];
      },
      async read() {
        return { title: 'stub', authors: [] };
      },
    });

    const store = new FakeVectorStore();
    const embedder = new FakeEmbeddingProvider();

    await ingestText(
      LONG_TEXT,
      'zzfingest_stamp_source',
      'doc1',
      'A Test Document',
      ['Author'],
      2024,
      'en',
      'https://example.test/doc1',
      undefined,
      { embedder, store },
    );

    assert.ok(store.lastChunks.length > 0);
    for (const chunk of store.lastChunks) {
      assert.equal(chunk.metadata.url, 'https://example.test/doc1');
      assert.equal(chunk.metadata.cluster, 'science');
    }
  });
});

// Task 11 (brief 07): chunkSemantic() prepends the title and nearest
// heading chain to a chunk's embedText, keeping the raw chunk in `text`
// unchanged - the embedding call must use embedText when present, and
// storage/display (FakeVectorStore.upsert here stands in for both) must
// still see the raw text.
test('chunkSemantic: title/heading-chain prefix on embedText, not on text', async (t) => {
  const original = process.env.ALEXANDRIA_CHUNK_PREFIX;
  t.after(() => {
    if (original === undefined) delete process.env.ALEXANDRIA_CHUNK_PREFIX;
    else process.env.ALEXANDRIA_CHUNK_PREFIX = original;
  });

  const withHeading = `# Chapter One\n\n${LONG_TEXT}`;

  await t.test('embedText carries "title > heading", text does not', () => {
    delete process.env.ALEXANDRIA_CHUNK_PREFIX;
    const chunks = chunkSemantic(withHeading, {
      source: 'gutenberg',
      sourceId: 'book1',
      title: 'My Book Title',
      authors: [],
    });

    assert.equal(chunks.length, 1);
    const [chunk] = chunks;
    assert.equal(chunk.text, LONG_TEXT, 'the displayed/stored text is the raw chunk, no prefix');
    assert.equal(chunk.embedText, `My Book Title > Chapter One\n\n${LONG_TEXT}`);
    assert.equal(chunk.metadata.section, '# Chapter One');
  });

  await t.test('ALEXANDRIA_CHUNK_PREFIX=off disables the prefix entirely', () => {
    process.env.ALEXANDRIA_CHUNK_PREFIX = 'off';
    const chunks = chunkSemantic(withHeading, {
      source: 'gutenberg',
      sourceId: 'book1',
      title: 'My Book Title',
      authors: [],
    });

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].embedText, undefined);
    assert.equal(chunks[0].text, LONG_TEXT);
  });

  await t.test(
    'end to end via ingestText: the embedder receives the prefixed text, the store receives the raw text',
    async () => {
      delete process.env.ALEXANDRIA_CHUNK_PREFIX;
      const store = new FakeVectorStore();
      const embedder = new FakeEmbeddingProvider();

      await ingestText(
        withHeading,
        'gutenberg',
        'book2',
        'My Book Title',
        ['Author'],
        1900,
        'en',
        undefined,
        undefined,
        { embedder, store },
      );

      assert.equal(store.lastChunks.length, 1);
      assert.equal(store.lastChunks[0].text, LONG_TEXT);
      assert.equal(embedder.received.length, 1);
      assert.equal(embedder.received[0], `My Book Title > Chapter One\n\n${LONG_TEXT}`);
    },
  );

  // Review round 1 (Minor): indexText()'s estimatedTokens is a preview of
  // the real ingestText() embedding call, so it must size against the same
  // string that call actually sends (embedText when the prefix is on) -
  // not the shorter displayed text, which would undercount.
  await t.test(
    'indexText: estimatedTokens sizes against embedText, not the shorter display text',
    () => {
      delete process.env.ALEXANDRIA_CHUNK_PREFIX;
      const withPrefix = indexText(withHeading, 'gutenberg', 'book3', 'My Book Title', ['Author']);

      process.env.ALEXANDRIA_CHUNK_PREFIX = 'off';
      const withoutPrefix = indexText(withHeading, 'gutenberg', 'book3', 'My Book Title', [
        'Author',
      ]);
      delete process.env.ALEXANDRIA_CHUNK_PREFIX;

      assert.equal(withPrefix.totalChunks, 1);
      assert.equal(withoutPrefix.totalChunks, 1);
      assert.ok(
        withPrefix.estimatedTokens > withoutPrefix.estimatedTokens,
        `expected the prefixed estimate (${withPrefix.estimatedTokens}) to exceed the unprefixed one (${withoutPrefix.estimatedTokens})`,
      );
    },
  );
});
