-- Task 12: corpus-as-cache read-through for library_answer.
--
-- Used by src/pipeline/providers/supabase.ts's SupabaseVectorStoreProvider.
-- query() (called from src/pipeline/corpusSearch.ts), selected whenever
-- SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set and the `embeddings` role
-- is configured. Runs a cosine-similarity nearest-neighbor search over the
-- knowledge_chunks table library_ingest already writes to (see README's
-- "Supabase Schema" section), returning source/source_id/chunk_index
-- pulled back out of each row's JSONB metadata column rather than as
-- separate columns, since that's where library_ingest stores them
-- (src/pipeline/index.ts's ChunkMetadata).
--
-- This file was written against the current pgvector/supabase-js docs but
-- was never executed against a live database - there is no Supabase
-- project in this environment. Apply it by hand in the Supabase SQL editor
-- and verify the `<=>` cosine-distance ordering and the HNSW index build
-- against your own knowledge_chunks row count before relying on it.

-- Assumes the default table name (knowledge_chunks); if SUPABASE_TABLE is
-- set to something else, substitute it below.

create or replace function match_knowledge_chunks(
  query_embedding vector,
  match_count int,
  min_similarity float,
  sources text[] default null
)
returns table (
  id bigint,
  source text,
  source_id text,
  chunk_index int,
  content text,
  similarity float,
  metadata jsonb
)
language sql
stable
as $$
  select
    knowledge_chunks.id,
    knowledge_chunks.metadata ->> 'source' as source,
    knowledge_chunks.metadata ->> 'sourceId' as source_id,
    (knowledge_chunks.metadata ->> 'chunkIndex')::int as chunk_index,
    knowledge_chunks.content,
    1 - (knowledge_chunks.embedding <=> query_embedding) as similarity,
    knowledge_chunks.metadata
  from knowledge_chunks
  where 1 - (knowledge_chunks.embedding <=> query_embedding) >= min_similarity
    -- Review round 1 (Important 3): an empty array (as opposed to a NULL
    -- one) must also mean "no filter", not "match nothing" - `= any('{}')`
    -- is always false, so without the cardinality check corpusSearch.ts
    -- (or any other caller) passing `[]` would silently get zero rows back.
    and (
      sources is null
      or cardinality(sources) = 0
      or knowledge_chunks.metadata ->> 'source' = any(sources)
    )
    -- Review round 1 (Important 2): honor a timeboxed ingest's retention
    -- deadline (src/sources/ingestPolicy.ts's ingestMetadata() stamps
    -- metadata.expiresAt) on the read path too, not just at write time.
    and (
      knowledge_chunks.metadata ->> 'expiresAt' is null
      or (knowledge_chunks.metadata ->> 'expiresAt')::timestamptz > now()
    )
  order by knowledge_chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- README's original schema indexed `embedding` with ivfflat, which needs a
-- representative row count at build time (`lists = 100`) to be effective
-- and doesn't improve as the table grows. HNSW builds incrementally and
-- needs no such tuning constant, so this migration replaces it outright;
-- drop the old index first since a table only needs one ANN index on the
-- same column/operator class.
drop index if exists knowledge_chunks_embedding_idx;

create index if not exists knowledge_chunks_embedding_hnsw_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- Minor: HNSW's query-time recall/speed tradeoff is controlled by
-- hnsw.ef_search (default 40, the size of the dynamic candidate list a
-- search scans) rather than an index-build parameter - raise it (e.g. to
-- 100) in a session or transaction if corpus-as-cache hits are missing
-- results a straight `<=>` scan would have found, at the cost of a slower
-- match_knowledge_chunks() call.
-- set hnsw.ef_search = 100;
