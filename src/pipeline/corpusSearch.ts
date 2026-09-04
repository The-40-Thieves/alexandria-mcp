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
import type { IngestPolicy } from '../sources/ingestPolicy.ts';
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

interface CacheableSourceInfo {
  homepage?: string;
  cluster?: string;
  // Final wave (E3): carried so every returned hit can be re-checked
  // against the policy, not just filtered by the query.
  ingestPolicy: IngestPolicy;
}

// A source is only ever served from the cache when its registry freshness
// is "static" or "daily" - "realtime" clusters (news, markets, ...) must
// never answer from a chunk that could already be stale by the time this
// query runs. Read fresh on every call rather than cached at module load,
// same reasoning src/sources/registry.ts's own listSources() callers use.
//
// Final wave (E3): a source whose ingestPolicy is 'forbidden' is excluded
// here too, so it never even enters the query filter. This filtered on
// freshness alone, and freshness has nothing to do with whether a source's
// terms allow storing its text: trove is registered daily AND forbidden,
// so a pre-policy or externally inserted trove chunk in the vector store
// was returned, embedded into answers, and cited. library_ingest refuses
// to WRITE such a chunk; the read path has to refuse to serve one.
//
// Carries homepage/cluster too: Review round 1 (Important 1)'s fallback
// for a chunk ingested before ChunkMetadata.url/cluster existed uses the
// *current* registry entry for the chunk's source, and this is already
// the one pass over listSources() that has it in hand.
function cacheableSources(): Map<string, CacheableSourceInfo> {
  const sources = new Map<string, CacheableSourceInfo>();
  for (const s of listSources()) {
    const policy = s.ingestPolicy ?? 'allowed';
    if (policy === 'forbidden') continue;
    if (s.freshness === 'static' || s.freshness === 'daily') {
      sources.set(s.name, { homepage: s.homepage, cluster: s.cluster, ingestPolicy: policy });
    }
  }
  return sources;
}

// Review round 1 (Important 2): a timeboxed ingest policy stamps
// metadata.expiresAt on every chunk it writes (src/sources/ingestPolicy.ts's
// ingestMetadata()); the read path must honor that retention deadline too,
// or an expired chunk keeps answering queries after it was meant to expire.
//
// Final wave (E3): for a TIMEBOXED source the deadline is now required,
// not merely honored when present. A missing or unparseable expiresAt used
// to mean "never expires", which is the exact opposite of what a retention
// window means - and it is the shape a chunk written before the policy
// existed, or inserted by something other than library_ingest, actually
// has. Fails closed: no valid future deadline, no serve.
function isServable(policy: IngestPolicy, expiresAt: string | undefined): boolean {
  const deadline = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (policy === 'timeboxed') return Number.isFinite(deadline) && deadline > Date.now();
  if (policy === 'forbidden') return false;
  return !Number.isFinite(deadline) || deadline > Date.now();
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

  const allowed = cacheableSources();
  if (allowed.size === 0) return [];

  const [queryVector] = await embedFn([query]);
  const store = providers.store ?? (await defaultStore());
  const hits = await store.query(queryVector, CANDIDATE_POOL, { sources: [...allowed.keys()] });

  const minSim = config.ALEXANDRIA_CORPUS_MIN_SIM;
  return hits
    .filter((h) => {
      if (h.similarity < minSim) return false;
      // Final wave (E3): the policy is re-checked on every returned hit,
      // not trusted to the query filter. A provider that ignores or
      // mis-applies the `sources` filter (or a future one that does its
      // own thing) must not be the only thing standing between a
      // forbidden chunk and an answer.
      const info = allowed.get(h.source);
      if (!info) return false;
      return isServable(info.ingestPolicy, h.metadata.expiresAt);
    })
    .map((h) => {
      const registryInfo = allowed.get(h.source);
      return {
        id: buildId(h.source, h.sourceId, h.chunkIndex),
        source: 'corpus',
        title: h.metadata.title || h.source,
        authors: h.metadata.authors ?? [],
        year: h.metadata.year,
        language: h.metadata.language,
        hasFullText: true,
        fullText: h.text,
        // Review round 1 (Important 1): fall back to the current registry
        // entry for a chunk ingested before url/cluster were stamped, so a
        // pre-existing corpus row still cites and grades correctly.
        url: h.metadata.url ?? registryInfo?.homepage,
        cluster: h.metadata.cluster ?? registryInfo?.cluster,
      };
    });
}

// Test-only indirection: src/tools/libraryAnswer.ts calls
// corpusSearchRef.search(query) rather than the corpusSearch export
// directly, so a test can swap in a fake without a live Supabase project
// or embeddings key. Same pattern as src/web/fetchTier.ts's dnsResolver.
export const corpusSearchRef: { search: typeof corpusSearch } = { search: corpusSearch };
