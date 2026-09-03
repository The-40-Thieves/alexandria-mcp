// Task 12 (vault idea 5): corpus as cache. library_ingest already writes
// embedded chunks into Supabase for every source it's pointed at; this
// module reads them back as a zero-latency "source" for library_answer,
// alongside the live per-source searches and the optional knowledge_search
// list. A hit here already carries its full chunk text, so
// src/tools/libraryAnswer.ts's readTopSources() can skip the adapter
// read() round-trip entirely for it.
//
// Gated on SUPABASE_URL (nothing to read from otherwise) plus a configured
// `embeddings` role (nothing to embed the query with). Both missing is the
// common case for a deployment that never ran library_ingest, so this
// returns [] rather than throwing - the same "quietly absent" contract
// fetchKnowledgeResults() uses for KNOWLEDGE_MCP_URL.
import { config } from '../config.ts';
import { listSources } from '../sources/registry.ts';
import type { LibraryResult, VectorStoreProvider } from '../types.ts';
import { embed, hasEmbeddingsConfigured } from '../utils/providers.ts';
import { buildVectorStoreProvider, resolveConfig } from './providers/index.ts';

// How many nearest-neighbor chunks to pull from the store before similarity
// and freshness filtering. Generous relative to library_answer's own
// resultsPerSource default (5) since most candidates get filtered out by
// ALEXANDRIA_CORPUS_MIN_SIM.
const CANDIDATE_POOL = 20;

export interface CorpusSearchProviders {
  embed?: (texts: string[]) => Promise<number[][]>;
  store?: VectorStoreProvider;
}

let cachedStore: VectorStoreProvider | undefined;

async function defaultStore(): Promise<VectorStoreProvider> {
  if (!cachedStore) cachedStore = await buildVectorStoreProvider(resolveConfig().vectorStore);
  return cachedStore;
}

// A source is only ever served from the cache when its registry freshness
// is "static" or "daily" - "realtime" clusters (news, markets, ...) must
// never answer from a chunk that could already be stale by the time this
// query runs. Read fresh on every call rather than cached at module load,
// same reasoning src/sources/registry.ts's own listSources() callers use.
function cacheableSourceNames(): Set<string> {
  const names = new Set<string>();
  for (const s of listSources()) {
    if (s.freshness === 'static' || s.freshness === 'daily') names.add(s.name);
  }
  return names;
}

// Composite id encodes the chunk's original source/sourceId/chunkIndex for
// display/debugging; the LibraryResult's own `source` field below is always
// the literal 'corpus', which is deliberately never a registered adapter -
// library_answer's readTopSources() must use `fullText` directly instead of
// ever calling getAdapter('corpus').read().
function buildId(source: string, sourceId: string, chunkIndex: number): string {
  return `${source}:${sourceId}:${chunkIndex}`;
}

export async function corpusSearch(
  query: string,
  providers: CorpusSearchProviders = {},
): Promise<LibraryResult[]> {
  if (!config.SUPABASE_URL) return [];

  const embedFn = providers.embed ?? embed;
  if (!providers.embed && !hasEmbeddingsConfigured()) return [];

  const allowed = cacheableSourceNames();
  if (allowed.size === 0) return [];

  const [queryVector] = await embedFn([query]);
  const store = providers.store ?? (await defaultStore());
  const hits = await store.query(queryVector, CANDIDATE_POOL, { sources: [...allowed] });

  const minSim = config.ALEXANDRIA_CORPUS_MIN_SIM;
  return hits
    .filter((h) => h.similarity >= minSim && allowed.has(h.source))
    .map((h) => ({
      id: buildId(h.source, h.sourceId, h.chunkIndex),
      source: 'corpus',
      title: h.metadata.title || h.source,
      authors: h.metadata.authors ?? [],
      year: h.metadata.year,
      language: h.metadata.language,
      hasFullText: true,
      fullText: h.text,
    }));
}

// Test-only indirection: src/tools/libraryAnswer.ts calls
// corpusSearchRef.search(query) rather than the corpusSearch export
// directly, so a test can swap in a fake without a live Supabase project
// or embeddings key. Same pattern as src/web/fetchTier.ts's dnsResolver.
export const corpusSearchRef: { search: typeof corpusSearch } = { search: corpusSearch };
