// THE-319/320: the registry-generated catalog that stage 1 of libraryAsk's
// two-stage router narrows before an LLM ever sees the query (src/tools/
// libraryAsk.ts). Embeds `${name}: ${description} (cluster ${cluster})` for
// every non-hidden source in the registry when an embeddings role is
// configured; falls back to a small in-repo BM25 ranker (with cluster
// keyword boosts) when it isn't, so stage 1 still returns sane candidates
// with zero external calls.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Cluster, catalog, type Freshness } from '../sources/registry.ts';
import { embed, hasEmbeddingsConfigured } from './providers.ts';

export interface CatalogEntry {
  name: string;
  text: string;
  cluster: Cluster;
  freshness: Freshness;
  vector?: number[];
}

// Resolved from __dirname, not process.cwd(): the default used to depend on
// where the process was started, so the same install read and wrote a
// different cache file per working directory (and, run from anywhere but
// the repo root, silently re-embedded the whole catalog every start).
// __dirname is dist/utils/ after a build and src/utils/ under tsx, so
// ../../eval lands at the package root either way.
// ALEXANDRIA_CATALOG_CACHE overrides it, which is also how tests point
// persistence at a throwaway file.
const DEFAULT_CACHE_PATH = path.resolve(__dirname, '../../eval/catalog-embeddings.json');

function cachePath(): string {
  return process.env.ALEXANDRIA_CATALOG_CACHE ?? DEFAULT_CACHE_PATH;
}

function entryText(name: string, description: string, cluster: Cluster): string {
  return `${name}: ${description} (cluster ${cluster})`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type EmbeddingCacheFile = Record<string, number[]>;

function loadCacheFile(): EmbeddingCacheFile {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as EmbeddingCacheFile;
  } catch {
    return {};
  }
}

function saveCacheFile(cache: EmbeddingCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort persistence; an unwritable eval/ directory shouldn't break
    // routing, it only means the next process restart re-embeds.
  }
}

let cachedCatalog: CatalogEntry[] | undefined;

// From catalog(); embeds when an embeddings role is configured, cached in
// memory for the process and persisted to disk keyed by sha256 of the text
// so restarts skip re-embedding unchanged sources.
export async function buildCatalog(): Promise<CatalogEntry[]> {
  if (cachedCatalog) return cachedCatalog;

  const entries: CatalogEntry[] = catalog().map((s) => ({
    name: s.name,
    text: entryText(s.name, s.description, s.cluster),
    cluster: s.cluster,
    freshness: s.freshness,
  }));

  if (!hasEmbeddingsConfigured()) {
    cachedCatalog = entries;
    return entries;
  }

  const diskCache = loadCacheFile();
  const toEmbed = entries.filter((e) => {
    const cached = diskCache[sha256(e.text)];
    if (cached) {
      e.vector = cached;
      return false;
    }
    return true;
  });

  if (toEmbed.length > 0) {
    const vectors = await embed(toEmbed.map((e) => e.text));
    for (let i = 0; i < toEmbed.length; i++) {
      toEmbed[i].vector = vectors[i];
      diskCache[sha256(toEmbed[i].text)] = vectors[i];
    }
    saveCacheFile(diskCache);
  }

  cachedCatalog = entries;
  return entries;
}

// Test-only: clears the in-memory cache so a test can flip
// hasEmbeddingsConfigured() / ALEXANDRIA_CATALOG_CACHE and rebuild.
export function resetCatalogCacheForTests(): void {
  cachedCatalog = undefined;
}

// ─── BM25 fallback ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'for',
  'to',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'with',
  'by',
  'at',
  'from',
  'this',
  'that',
  'it',
  'its',
  'be',
  'as',
  'about',
  'into',
  'over',
  'last',
  'me',
  'my',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Rough keyword -> cluster association used to boost a whole cluster's
// entries when the query clearly names that domain, on top of plain
// term-frequency scoring against each source's own description.
const CLUSTER_KEYWORDS: Record<Cluster, string[]> = {
  literature: ['book', 'books', 'novel', 'poem', 'poetry', 'fiction', 'ebook', 'gutenberg'],
  culture: ['museum', 'art', 'heritage', 'cultural', 'photograph', 'artifact', 'exhibit'],
  archives: ['archive', 'archival', 'historical', 'records', 'manuscript', 'newspaper'],
  academic: ['paper', 'papers', 'study', 'research', 'journal', 'preprint', 'citation'],
  science: ['science', 'scientific', 'physics', 'biology', 'chemistry', 'experiment', 'astronomy'],
  government: ['government', 'federal', 'agency', 'congress', 'regulation', 'policy', 'census'],
  law: ['law', 'legal', 'court', 'case', 'statute', 'legislation', 'ruling', 'litigation'],
  security: ['cve', 'vulnerability', 'exploit', 'security', 'malware', 'patch', 'advisory'],
  developer: [
    'code',
    'github',
    'repository',
    'api',
    'library',
    'package',
    'documentation',
    'sdk',
    'npm',
  ],
  standards: ['standard', 'spec', 'specification', 'rfc', 'protocol', 'w3c', 'ietf'],
  markets: ['stock', 'market', 'price', 'index', 'trading', 'equity', 'etf', 'commodity', 'crypto'],
  economics: ['economy', 'economic', 'gdp', 'inflation', 'unemployment', 'fed', 'rate'],
  real_estate: ['housing', 'mortgage', 'rent', 'home', 'property', 'real estate'],
  news_global: ['news', 'breaking', 'headline', 'world', 'today'],
  news_regional: ['regional', 'local', 'asia', 'europe', 'africa', 'middle east', 'japan'],
  geopolitical: [
    'geopolitical',
    'conflict',
    'war',
    'sanctions',
    'diplomacy',
    'military',
    'shipping',
  ],
  ai_research: ['ai', 'machine learning', 'llm', 'neural', 'model', 'deep learning'],
  video: ['video', 'lecture', 'youtube', 'talk', 'transcript'],
  web: ['website', 'webpage', 'url', 'fetch', 'crawl', 'page'],
};

function matchedClusters(query: string): Set<Cluster> {
  const q = query.toLowerCase();
  const matched = new Set<Cluster>();
  for (const [cluster, keywords] of Object.entries(CLUSTER_KEYWORDS) as Array<
    [Cluster, string[]]
  >) {
    if (keywords.some((kw) => q.includes(kw))) matched.add(cluster);
  }
  return matched;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const CLUSTER_KEYWORD_BOOST = 1.5;
const FRESHNESS_RANK: Record<Freshness, number> = { realtime: 2, daily: 1, static: 0 };
const FRESHNESS_BOOST = 1.3;

// Full corpus ranked best-first; bm25Candidates() below just slices this.
function rankBm25(
  query: string,
  entries: CatalogEntry[],
  preferredFreshness?: Freshness,
): CatalogEntry[] {
  if (entries.length === 0) return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return entries;

  const docTokens = entries.map((e) => tokenize(e.text));
  const docLengths = docTokens.map((t) => t.length);
  const avgLen = docLengths.reduce((a, b) => a + b, 0) / (docLengths.length || 1) || 1;

  const docFreq = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const n = entries.length;
  const queryClusters = matchedClusters(query);
  const preferredRank = preferredFreshness ? FRESHNESS_RANK[preferredFreshness] : undefined;

  const scored = entries.map((entry, i) => {
    const tokens = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * docLengths[i]) / avgLen);
      score += idf * ((f * (BM25_K1 + 1)) / denom);
    }
    // A source with no term overlap at all but a matching cluster still
    // gets a small floor score so cluster-keyword matches surface even when
    // the description's wording differs from the query's.
    if (queryClusters.has(entry.cluster)) score = score > 0 ? score * CLUSTER_KEYWORD_BOOST : 0.01;
    if (preferredRank !== undefined && FRESHNESS_RANK[entry.freshness] >= preferredRank) {
      score *= FRESHNESS_BOOST;
    }
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.entry);
}

// Token overlap with cluster keyword boosts; the fallback stage-1 path when
// no embeddings role is configured.
export function bm25Candidates(query: string, entries: CatalogEntry[], k: number): CatalogEntry[] {
  return rankBm25(query, entries).slice(0, k);
}

// ─── Cosine ranking (when the catalog was embedded) ────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function rankCosine(
  query: string,
  entries: CatalogEntry[],
  preferredFreshness?: Freshness,
): Promise<CatalogEntry[]> {
  const [queryVector] = await embed([query]);
  const preferredRank = preferredFreshness ? FRESHNESS_RANK[preferredFreshness] : undefined;
  const scored = entries.map((entry) => {
    let score = entry.vector ? cosineSimilarity(queryVector, entry.vector) : -1;
    if (preferredRank !== undefined && FRESHNESS_RANK[entry.freshness] >= preferredRank) {
      score *= FRESHNESS_BOOST;
    }
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.entry);
}

// Every entry of the rank-0 cluster is guaranteed a slot (up to k total),
// then the remaining slots are filled in rank order from every cluster.
// Both passes iterate `ranked` (score order), never the pre-ranking pool
// (catalog/file order): filling the top cluster's slots from the raw pool
// would scramble that cluster's own internal ordering by wherever each
// source happens to be registered, undoing the ranker's actual score order
// within the one cluster stage 2 is about to see the most of.
// Exported so a test can exercise it directly against a synthetic ranked
// list, instead of only indirectly through candidates() (which always
// goes through buildCatalog()'s registry-backed catalog).
export function withClusterFloor(ranked: CatalogEntry[], k: number): CatalogEntry[] {
  const topCluster = ranked[0]?.cluster;
  const result: CatalogEntry[] = [];
  const have = new Set<string>();

  if (topCluster) {
    for (const entry of ranked) {
      if (entry.cluster !== topCluster) continue;
      if (result.length >= k) break;
      result.push(entry);
      have.add(entry.name);
    }
  }
  for (const entry of ranked) {
    if (result.length >= k) break;
    if (have.has(entry.name)) continue;
    result.push(entry);
    have.add(entry.name);
  }
  return result;
}

// Cosine top-k when the catalog carries vectors, else BM25. Always includes
// every entry of the top-scoring cluster, up to k total.
export async function candidates(
  query: string,
  k: number,
  opts?: { freshness?: Freshness },
): Promise<CatalogEntry[]> {
  const pool = await buildCatalog();
  const hasVectors = pool.length > 0 && pool.every((e) => e.vector !== undefined);

  const ranked = hasVectors
    ? await rankCosine(query, pool, opts?.freshness)
    : rankBm25(query, pool, opts?.freshness);

  return withClusterFloor(ranked, k);
}
