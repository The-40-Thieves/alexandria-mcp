// Task 5 (review 3.6): one validated schema for the ops-level environment -
// transport/port, the per-role LLM provider table, caches, state/ledger
// backends, the fetch tier, KNOWLEDGE_MCP delegation, and the ingest
// pipeline's storage vars. Everything a *source adapter* reads
// (src/sources/*.ts's `auth`/`optionalEnv` declarations, CONTACT_EMAIL,
// TAVILY_API_KEY, and friends) stays exactly where it is - registry.ts's
// isConfigured()/requireKey() keep reading process.env directly, since
// those env var names are per-adapter data, not a fixed set this schema can
// enumerate.
//
// Field names are literally the env var names (ALEXANDRIA_ROUTER_MODEL, not
// routerModel): that keeps every call site a mechanical `process.env.X` ->
// `config.X` swap, and lets scripts/gen-docs.ts read `.describe()` off each
// field to generate .env.example's "Feature envs" section instead of
// hand-maintaining a parallel list.
//
// `config` is a lazy, ALWAYS-fresh view: each property read re-parses the
// live `process.env` (via loadConfig()) rather than caching a snapshot
// forever. Two things this repo already relies on drove that choice over a
// classic parse-once singleton:
//   1. Nothing must happen at import time - config.ts is imported
//      transitively by nearly everything, including scripts run without
//      the npm test script's env prefix (gen-docs, probe, eval-routing).
//   2. Dozens of existing tests set/delete process.env vars per test case
//      (providers.test.ts, catalogIndex.test.ts, fetchTier.test.ts, the
//      library*.test.ts files) and expect the very next call to observe
//      the change, the same contract process.env itself gives them today.
//      A cached-forever singleton would silently freeze the FIRST test's
//      env for every later test in the same process; re-deriving on every
//      access preserves that contract with zero test rewrites.
// The cost is re-validating ~50 optional string fields on each access,
// which is microseconds and happens at most a few dozen times per tool
// call - not a hot loop - so correctness and test-compatibility win over
// memoizing.
import { z } from 'zod';

// Per-role override quartet (see src/utils/providers.ts's Role/envKey):
// ALEXANDRIA_<ROLE>_BASE_URL / _API_KEY / _MODEL / _JSON_MODE, for each of
// router/synth/research/embeddings/rerank. A template-literal computed key
// inside a plain object literal keeps its precise literal type (verified
// under tsc); a helper function returning the same shape does not - its
// return type widens to `Record<string, ...>` and every per-role field
// then fails to typecheck as a known key of Config. Typed out per role
// instead of via a loop for that reason.
type RoleFields<Role extends string> = {
  [K in `ALEXANDRIA_${Role}_BASE_URL` | `ALEXANDRIA_${Role}_API_KEY`]: z.ZodOptional<z.ZodString>;
} & {
  [K in `ALEXANDRIA_${Role}_MODEL` | `ALEXANDRIA_${Role}_JSON_MODE`]: z.ZodOptional<z.ZodString>;
};

function roleFields<const Role extends string>(role: Role, lower: string): RoleFields<Role> {
  return {
    [`ALEXANDRIA_${role}_BASE_URL`]: z
      .string()
      .optional()
      .describe(
        `Per-role override: OpenAI-compatible base URL for the ${lower} role. Falls back to ALEXANDRIA_BASE_URL, then https://api.openai.com/v1.`,
      ),
    [`ALEXANDRIA_${role}_API_KEY`]: z
      .string()
      .optional()
      .describe(
        `Per-role override: API key for the ${lower} role. Falls back to ALEXANDRIA_API_KEY, then OPENAI_API_KEY.`,
      ),
    [`ALEXANDRIA_${role}_MODEL`]: z
      .string()
      .optional()
      .describe(`Per-role override: model name for the ${lower} role.`),
    [`ALEXANDRIA_${role}_JSON_MODE`]: z
      .string()
      .optional()
      .describe(
        `Set to "1" to confirm the ${lower} role's gateway/model honors OpenAI's response_format: json_object; otherwise a JSON instruction is appended to the prompt instead.`,
      ),
  } as RoleFields<Role>;
}

// An env-file loader commonly emits a declared-but-empty var as "" (KEY=,
// the exact shape .env.example uses for every optional field). Before the
// final wave (A6), that "" reached each field's own zod type directly:
// z.coerce.number() turns it into 0 (finite, often in-range, so PORT=
// or ALEXANDRIA_CACHE_TTL_MS= silently became an explicit 0 instead of
// falling back to a default), and z.enum(...) rejects it outright (so a
// single declared-but-unset TRANSPORT=, LOG_LEVEL=, ALEXANDRIA_LEDGER=,
// or ALEXANDRIA_RERANK= failed the WHOLE parse, not just that field) -
// only ALEXANDRIA_CACHE_TTL_MS and ALEXANDRIA_ROUTER_SKIP_MARGIN (via
// optionalNumericString below) got this treatment. emptyToUndefined()
// wraps an already-built field schema (whatever combination of
// .optional()/.default()/.enum()/.describe() it already has) so
// empty-or-whitespace-only input hits the schema as `undefined` instead -
// falling through to that field's own `.default()` when it has one, or
// staying unset otherwise - applied uniformly to every field below so a
// declared-but-empty optional var never fails the parse. Genuinely-set,
// invalid values (non-numeric, out of enum) still reach that field's own
// validation and fail exactly as before.
function emptyToUndefined<T extends z.ZodTypeAny>(inner: T) {
  const wrapped = z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    inner,
  );
  return inner.description ? wrapped.describe(inner.description) : wrapped;
}

// Thin convenience over emptyToUndefined for the two fields
// (ALEXANDRIA_CACHE_TTL_MS, ALEXANDRIA_ROUTER_SKIP_MARGIN) that are parsed
// downstream with Number(raw), falling back to a built-in default for
// anything non-finite (resultCache.ts's parseTtlMs, libraryAsk.ts's
// parseSkipMargin) rather than being coerced to a number here.
function optionalNumericString(description: string): z.ZodType<string | undefined> {
  return emptyToUndefined(z.string().optional().describe(description));
}

// Every field's raw definition, exactly as before this wave (whatever
// combination of .optional()/.default()/.enum()/.describe() each one
// already had) - wrapped uniformly by emptyToUndefined() below rather than
// rewritten field by field, so "" behaves like unset everywhere at once.
const rawFields = {
  // ── Transport ────────────────────────────────────────────────────────
  TRANSPORT: z
    .enum(['stdio', 'http'])
    .default('stdio')
    .describe('MCP transport: "stdio" (default) or "http".'),
  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(3000)
    .describe('HTTP transport port (TRANSPORT=http only).'),

  // ── HTTP guards (src/httpGuards.ts, TRANSPORT=http only) ────────────────
  ALEXANDRIA_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .describe(
      'Comma-separated hostnames (no scheme/port) allowed to reach /mcp: checked against both the Host and Origin headers for DNS-rebinding protection. Loopback (localhost, 127.0.0.1, [::1]) is always allowed regardless of this setting.',
    ),
  ALEXANDRIA_HTTP_RATE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(60)
    .describe(
      'Max /mcp requests per client IP per minute (a token bucket refilling continuously toward this cap). Exceeding it returns 429 with a JSON-RPC error body.',
    ),

  // ── Shared LLM provider table ───────────────────────────────────────────
  ALEXANDRIA_BASE_URL: z
    .string()
    .optional()
    .describe(
      'Shared OpenAI-compatible gateway base URL for every role (router/synth/research/embeddings/rerank).',
    ),
  ALEXANDRIA_API_KEY: z
    .string()
    .optional()
    .describe('Shared API key paired with ALEXANDRIA_BASE_URL.'),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .describe(
      'Direct OpenAI API key. Used when no gateway is configured, and as the automatic fallback target when a configured gateway errors.',
    ),
  ...roleFields('ROUTER', 'router'),
  ...roleFields('SYNTH', 'synth'),
  ...roleFields('RESEARCH', 'research'),
  ...roleFields('EMBEDDINGS', 'embeddings'),
  ...roleFields('RERANK', 'rerank'),
  // Task 10: 'llm' is the original listwise-chat backend (over at most 20
  // shuffled candidates - src/utils/rerank.ts). 'cohere' and 'workers-ai'
  // are true cross-encoder backends, both resolved through the same
  // ALEXANDRIA_RERANK_BASE_URL/_API_KEY/_MODEL as 'llm' rather than a
  // second set of env vars: 'cohere' POSTs the Cohere/Jina/Voyage-shaped
  // request to "<base>/rerank", 'workers-ai' POSTs Cloudflare's
  // {query, contexts} shape straight to ALEXANDRIA_RERANK_BASE_URL (already
  // the full per-account model run URL for that backend). Unset behaves
  // exactly like the explicit 'off' value: the fused order is kept.
  ALEXANDRIA_RERANK: z
    .enum(['off', 'llm', 'cohere', 'workers-ai'])
    .optional()
    .describe(
      'Rerank backend for library_answer\'s fused candidate pool: "llm" (listwise chat rerank), "cohere" (POST <rerank base>/rerank, Cohere request shape), or "workers-ai" (Cloudflare bge-reranker-base {query, contexts} shape). Unset or "off" keeps the fused order.',
    ),
  ALEXANDRIA_RERANK_POOL: z.coerce
    .number()
    .int()
    .positive()
    .default(60)
    .describe(
      "How many of RRF's fused results library_answer hands to the configured rerank backend before reading/citing. The 'llm' backend further caps its own listwise input to the top 20 of this pool.",
    ),
  ALEXANDRIA_MULTI_QUERY: z
    .enum(['1'])
    .optional()
    .describe(
      'Set to "1" to have library_ask/library_answer ask the router role for two alternate phrasings when stage 1\'s margin is below the router-skip margin, running stage 1 again for each and unioning the shortlists before stage 2. Off by default.',
    ),
  ...roleFields('VERIFY', 'verify'),
  ALEXANDRIA_CLAIM_CHECK: z
    .enum(['off'])
    .optional()
    .describe(
      'Set to "off" to disable library_answer/library_research claim verification (the verify role checking each cited sentence against its source text). On by default; verify falls back to the synth role when ALEXANDRIA_VERIFY_* is unset.',
    ),

  // ── Routing (src/tools/libraryAsk.ts, src/utils/catalogIndex.ts) ────────
  ALEXANDRIA_ROUTER_SKIP_MARGIN: optionalNumericString(
    "Stage-1 confidence margin (0-1: top candidate score minus the score at max_sources+1, normalised by the top score) at or above which library_ask skips the LLM router call and fans out to stage 1's top max_sources directly with the raw query. Unset (or empty) uses the built-in default; an explicit, non-negative value opts in even in BM25 mode (see docs/routing-eval.md).",
  ),

  // ── Caches / state / ledger ─────────────────────────────────────────────
  ALEXANDRIA_CACHE_TTL_MS: optionalNumericString(
    'Search result cache TTL in milliseconds. Unset (or empty) or non-numeric uses the built-in default.',
  ),
  ALEXANDRIA_CATALOG_CACHE: z
    .string()
    .optional()
    .describe(
      'Path to the routing catalog embedding cache. Defaults to eval/catalog-embeddings.json inside the package.',
    ),
  ALEXANDRIA_HTTP_CACHE: z
    .string()
    .optional()
    .describe(
      'Path to the shared undici RFC 9111 http-cache SQLite database. Defaults to data/http-cache.db inside the package; set to ":memory:" to force the in-memory store, or falls back to it automatically if the path can\'t be created.',
    ),
  ALEXANDRIA_STATE_DB: z
    .string()
    .optional()
    .describe(
      'Path to the node:sqlite database backing the daily quota ledger and search result cache. Defaults to data/alexandria.db inside the package; set to ":memory:" to force the in-memory store, or falls back to it automatically if the path can\'t be created.',
    ),
  ALEXANDRIA_LEDGER: z
    .enum(['supabase'])
    .optional()
    .describe(
      'Set to "supabase" (with SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) to persist the daily quota ledger there instead of ALEXANDRIA_STATE_DB.',
    ),

  // ── Fetch tier (src/web/fetchTier.ts) ───────────────────────────────────
  ALEXANDRIA_FETCH_UA: z
    .string()
    .optional()
    .describe(
      'Overrides the User-Agent the defuddle fetch tier sends. Defaults to an honest, identifying string ("Alexandria/<version> (+https://github.com/The-40-Thieves/alexandria-mcp)"), not a browser impersonation.',
    ),
  ALEXANDRIA_ALLOW_LOOPBACK: z
    .string()
    .optional()
    .describe(
      'Test-only: lets the fetch tier SSRF guard reach 127.0.0.1/localhost. Never set in production.',
    ),
  SEARXNG_URL: z
    .string()
    .optional()
    .describe('Self-hosted SearXNG metasearch instance URL. Hides the searxng source without it.'),
  CRAWL4AI_URL: z
    .string()
    .optional()
    .describe(
      'Self-hosted crawl4ai headless-browser render server URL (fetch tier 3). Hides that tier without it.',
    ),
  CRAWL4AI_API_TOKEN: z
    .string()
    .optional()
    .describe('Bearer token for CRAWL4AI_URL, only needed if your instance requires auth.'),
  JINA_API_KEY: z
    .string()
    .optional()
    .describe(
      'Jina AI Reader/Search key. Required to unhide the jinasearch source; also enables fetch tier 2 (jina reader) as a fallback when set.',
    ),
  ALEXANDRIA_JINA_READER: z
    .string()
    .optional()
    .describe(
      'Set to 1 to use the jina reader fetch tier anonymously (20 RPM shared cap) when JINA_API_KEY is unset.',
    ),

  // ── knowledge_search delegation (src/tools/libraryAnswer.ts) ────────────
  KNOWLEDGE_MCP_URL: z
    .string()
    .optional()
    .describe(
      'Optional knowledge-base MCP server URL, folded into library_answer as one more ranked list.',
    ),
  KNOWLEDGE_MCP_TOKEN: z.string().optional().describe('Bearer token for KNOWLEDGE_MCP_URL.'),
  // Task 12: corpus-as-cache (src/pipeline/corpusSearch.ts). Folds
  // previously-ingested chunks (already in Supabase from library_ingest)
  // into library_answer as one more RRF list, read straight from the
  // stored text with no adapter round-trip. Gated on SUPABASE_URL plus a
  // configured `embeddings` role; only chunks from a source whose registry
  // freshness is "static" or "daily" are ever eligible - never "realtime".
  ALEXANDRIA_CORPUS_MIN_SIM: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.92)
    .describe(
      'Minimum cosine similarity (0-1) for a corpus-as-cache hit to be folded into library_answer. Only chunks from a "static" or "daily" freshness source are ever eligible.',
    ),

  // ── library_ingest storage (src/pipeline/**) ────────────────────────────
  SUPABASE_URL: z
    .string()
    .optional()
    .describe(
      'Supabase project URL. Required for library_ingest and for ALEXANDRIA_LEDGER=supabase.',
    ),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .optional()
    .describe(
      'Supabase service role key. Required for library_ingest and for ALEXANDRIA_LEDGER=supabase.',
    ),
  SUPABASE_TABLE: z
    .string()
    .optional()
    .describe('Table name for library_ingest chunks. Default knowledge_chunks.'),
  EMBEDDING_PROVIDER: z
    .string()
    .optional()
    .describe('library_ingest embedding provider. Only "openai" (the default) is implemented.'),
  VECTOR_STORE_PROVIDER: z
    .string()
    .optional()
    .describe(
      'library_ingest vector store provider. Only "supabase" (the default) is implemented.',
    ),
  ALEXANDRIA_CHUNK_PREFIX: z
    .enum(['off'])
    .optional()
    .describe(
      'Set to "off" to disable prepending the title and heading chain to each chunk\'s embedded text (src/pipeline/index.ts\'s chunkSemantic()). On by default; the raw chunk text stored and displayed is unaffected either way.',
    ),

  // ── Ingest policy (src/sources/ingestPolicy.ts) ─────────────────────────
  ALEXANDRIA_INGEST_TIMEBOXED: z
    .string()
    .optional()
    .describe(
      'Set to "1" to confirm you will delete stored text within its retention window before ' +
        'library_ingest is allowed to ingest a "timeboxed"-policy source (e.g. guardian, 24h). ' +
        'Unset refuses the ingest instead.',
    ),

  // ── Diagnostics ──────────────────────────────────────────────────────────
  NODE_ENV: z
    .string()
    .optional()
    .describe(
      'Standard Node environment name. Only "test" has a special meaning here: it makes src/log.ts default to a discard destination instead of real stderr, so `npm test` (which sets this) stays quiet unless a test captures log output itself.',
    ),
  DEBUG: z
    .string()
    .optional()
    .describe(
      'Set to any non-empty value to log extra diagnostics (also raises LOG_LEVEL to debug).',
    ),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .optional()
    .describe('pino log level. Defaults to "debug" when DEBUG is set, otherwise "info".'),
} satisfies Record<string, z.ZodTypeAny>;

// Object.fromEntries loses the precise per-key literal types (widens to a
// single `V` for every key), and casting the result to a shape type built
// from z.ZodType<z.infer<...>> (zod's generic base class) throws away the
// specific ZodOptional/ZodDefault wrapper each field's schema needs for zod
// to infer that key as optional/defaulted rather than a required field
// whose value happens to include undefined - which is exactly the
// distinction Pick<Config, K> callers (e.g. stateStore.ts's
// createStateStore(env: Pick<Config, 'ALEXANDRIA_STATE_DB'>)) rely on to
// accept a plain NodeJS.ProcessEnv. This mapped-type helper keeps each
// field's true wrapped type instead.
function wrapShape<S extends Record<string, z.ZodTypeAny>>(
  shape: S,
): { [K in keyof S]: ReturnType<typeof emptyToUndefined<S[K]>> } {
  const wrapped = {} as { [K in keyof S]: ReturnType<typeof emptyToUndefined<S[K]>> };
  for (const key of Object.keys(shape) as (keyof S)[]) {
    wrapped[key] = emptyToUndefined(shape[key]);
  }
  return wrapped;
}

const schema = z
  .object(wrapShape(rawFields))
  .describe('Alexandria ops-level environment: transport, providers, caches, and integrations.');

export type Config = z.infer<typeof schema>;

// Every field name this schema recognizes, in declaration order - used by
// scripts/gen-docs.ts to render .env.example's "Feature envs" section
// straight from the schema instead of a hand-maintained parallel list.
export const CONFIG_FIELDS: ReadonlyArray<{ name: string; description: string }> = Object.entries(
  schema.shape,
).map(([name, field]) => ({ name, description: field.description ?? '' }));

// Parses `env` once and returns a frozen, typed snapshot. A parse failure
// throws a single error naming every invalid variable (never its value) -
// the field names come from `.issues[].path`, which for this flat schema is
// always exactly the env var name.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new Error(`Invalid configuration; check these variables: ${names.join(', ')}`);
  }
  return Object.freeze(result.data);
}

const configTarget = {} as Config;
for (const key of Object.keys(schema.shape) as (keyof Config)[]) {
  Object.defineProperty(configTarget, key, {
    enumerable: true,
    get(): unknown {
      return loadConfig()[key];
    },
  });
}

// The module-level singleton every consumer reads from. Nothing is parsed
// at import time (no module-load side effect, matching stateStore.ts's
// LazyStateStore) - the first property access is the first parse, and
// every access after that re-parses process.env fresh (see the module
// comment above for why).
export const config: Config = configTarget;
