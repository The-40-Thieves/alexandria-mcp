import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../../config.ts';
import type { Chunk, ChunkMetadata, VectorQueryHit, VectorStoreProvider } from '../../types.ts';

// One row returned by the docs/sql/match_chunks.sql RPC function. source/
// source_id/chunk_index/metadata all come from the stored chunk's JSONB
// metadata column (see that file), not separate table columns.
interface MatchChunkRow {
  id: number | string;
  source: string | null;
  source_id: string | null;
  chunk_index: number | null;
  content: string;
  similarity: number;
  metadata: ChunkMetadata;
}

export class SupabaseVectorStoreProvider implements VectorStoreProvider {
  private client: SupabaseClient;
  private table: string;

  // Review round 1: an optional injected client lets
  // supabase.test.ts exercise query()'s argument-passing and row-mapping
  // against a fake `rpc()` without a live Supabase project, the same way
  // src/pipeline/index.ts's ingestText() takes an injectable
  // embedder/store. Every real caller (src/pipeline/providers/index.ts's
  // buildVectorStoreProvider()) omits it and still requires
  // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY to be set.
  constructor(client?: SupabaseClient) {
    const url = config.SUPABASE_URL;
    const key = config.SUPABASE_SERVICE_ROLE_KEY;

    if (!url) throw new Error('SUPABASE_URL is not set');
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

    this.client = client ?? createClient(url, key);
    this.table = config.SUPABASE_TABLE || 'knowledge_chunks';
  }

  async isDuplicate(sourceId: string, mcpName: string): Promise<boolean> {
    const { data } = await this.client
      .from('source_docs')
      .select('id')
      .eq('source_url', sourceId)
      .eq('mcp_name', mcpName)
      .limit(1);

    return (data?.length ?? 0) > 0;
  }

  async upsert(chunks: Chunk[], embeddings: number[][], mcpName: string): Promise<number> {
    if (chunks.length === 0) return 0;

    const rows = chunks.map((chunk, i) => ({
      content: chunk.text,
      embedding: embeddings[i],
      mcp_name: mcpName,
      metadata: chunk.metadata,
    }));

    // Insert in batches of 50 to avoid request size limits
    const BATCH = 50;
    let written = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error, data } = await this.client.from(this.table).insert(batch).select('id');

      if (error) throw new Error(`Supabase insert error: ${error.message}`);
      written += data?.length ?? 0;
    }

    // Record in source_docs for dedup
    const { sourceId, title, source } = chunks[0].metadata;
    await this.client.from('source_docs').upsert({
      source_url: sourceId,
      mcp_name: mcpName,
      title,
      source,
      chunk_count: written,
      indexed_at: new Date().toISOString(),
    });

    return written;
  }

  // Task 12: corpus-as-cache. Calls the match_knowledge_chunks() function
  // (docs/sql/match_chunks.sql) rather than building the `<=>` ORDER BY
  // query inline, since PostgREST's .rpc() is the only way to run a
  // similarity search through supabase-js. min_similarity is left at 0
  // here (return the raw top-k); the caller (src/pipeline/corpusSearch.ts)
  // applies ALEXANDRIA_CORPUS_MIN_SIM itself.
  //
  // Review round 1 (Important 3): `filter.sources` is passed through
  // as-is, including an empty array - `??` only substitutes on null/
  // undefined, so `[]` reaches the RPC call unchanged. match_knowledge_
  // chunks() treats a NULL *and* an empty sources array as "no filter"
  // (see its cardinality(sources) = 0 check), so omitting `filter` and
  // passing `{ sources: [] }` behave identically: search the whole store.
  async query(
    embedding: number[],
    k: number,
    filter?: { sources?: string[] },
  ): Promise<VectorQueryHit[]> {
    const { data, error } = await this.client.rpc('match_knowledge_chunks', {
      query_embedding: embedding,
      match_count: k,
      min_similarity: 0,
      sources: filter?.sources ?? null,
    });

    if (error) throw new Error(`match_knowledge_chunks failed: ${error.message}`);

    return ((data ?? []) as MatchChunkRow[]).map((row) => ({
      id: String(row.id),
      source: row.source ?? row.metadata?.source ?? '',
      sourceId: row.source_id ?? row.metadata?.sourceId ?? '',
      chunkIndex: row.chunk_index ?? row.metadata?.chunkIndex ?? 0,
      text: row.content,
      similarity: row.similarity,
      metadata: row.metadata,
    }));
  }
}
