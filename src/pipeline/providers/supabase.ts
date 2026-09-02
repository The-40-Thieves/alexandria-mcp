import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Chunk, VectorStoreProvider } from '../../types.ts';

export class SupabaseVectorStoreProvider implements VectorStoreProvider {
  private client: SupabaseClient;
  private table: string;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url) throw new Error('SUPABASE_URL is not set');
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

    this.client = createClient(url, key);
    this.table = process.env.SUPABASE_TABLE || 'knowledge_chunks';
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
}
