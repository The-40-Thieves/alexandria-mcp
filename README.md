# Alexandria

A Model Context Protocol (MCP) server for querying, reading, and ingesting texts from 152 public digital libraries. Works with any MCP-compatible client (Claude Desktop, Cursor, VS Code Copilot, etc.).

## Tools

| Tool | Description |
|---|---|
| `library_list_sources` | List all 152 sources with descriptions and full-text capabilities |
| `library_ask(query, max_sources?, results_per_source?)` | **Natural language search** — routes your query to the best sources, searches in parallel, returns unified deduplicated results |
| `library_search(query, source, limit?)` | Search a specific source by title, author, or keywords |
| `library_read(id, source)` | Fetch full text or metadata for an item (200k char limit) |
| `library_index(id, source)` | Dry run: chunk and score text quality without writing anything |
| `library_ingest(id, source)` | Chunk → embed → store in your vector database. Idempotent. |
| `library_recommend(id, limit?)` | Get similar papers via Semantic Scholar's recommendation engine (up to 500) |
| `library_answer(query, max_sources?, results_per_source?, read_top?)` | Ask a question and get a synthesized answer with inline `[n]` citations, fused across sources with reciprocal rank fusion; `warnings[]` flags an uncited or all-dropped answer |
| `library_research(query, depth?, breadth?, max_minutes?)` | Recursive multi-round research: generates queries, answers each, extracts learnings, and writes a final cited report over every source found |
| `library_health_check(source?, cluster?)` | Report per-source health (`ok`, `degraded`, `down`, `key_missing`, `unknown`), merging this process's live error rate/latency with the last off-process probe run |

`library_ask` is the primary entry point. `library_search` is for targeted queries against a known source. `library_index` / `library_ingest` are for building a vector knowledge base from retrieved texts. `library_answer` and `library_research` synthesize a cited answer or report instead of returning raw results. `library_health_check` tells you whether a source is worth calling before you call it.

`library_ask`, `library_search`, `library_answer`, `library_research`, and `library_health_check` take a `response_format: "concise" | "detailed"` parameter (default `concise`); concise trims results and citations to the high-signal fields (title, source, id, year, hasFullText, url; answer/report + citations; name, cluster, status), detailed returns the full payload, including routing reasons, relevance scores, per-stage diagnostics, and per-source error rate/latency/quota usage.

<!-- sources:start -->
## Sources (152)

152 sources across 19 clusters (36 hidden pending a key or config not present in this deployment). Full per-source detail, including auth env vars and last-verified dates, is generated in [docs/sources.md](docs/sources.md).

| Cluster | Sources | Hidden |
|---|---|---|
| academic | 22 | 3 |
| ai_research | 3 | 0 |
| archives | 4 | 2 |
| culture | 8 | 3 |
| developer | 17 | 5 |
| economics | 11 | 3 |
| geopolitical | 3 | 3 |
| government | 7 | 3 |
| law | 4 | 1 |
| literature | 16 | 2 |
| markets | 2 | 1 |
| news_global | 5 | 2 |
| news_regional | 15 | 0 |
| real_estate | 2 | 2 |
| science | 8 | 2 |
| security | 14 | 0 |
| standards | 3 | 0 |
| video | 1 | 1 |
| web | 7 | 3 |
| **Total** | 152 | 36 |

<!-- sources:end -->

## Credentials

Most tools query external library APIs directly and need no credentials at all. The two optional dependencies are scoped to specific tools:

### OpenAI, optional ([platform.openai.com](https://platform.openai.com/api-keys))

Required by two tools only:

- **`library_ask`**: uses `gpt-4o-mini` to route your natural language query to the right sources and generate optimized per-source search terms. Without this key, use `library_search` to query sources directly.
- **`library_ingest`**: uses `text-embedding-3-small` to embed chunked text before writing to the vector store.

`library_list_sources`, `library_search`, `library_read`, `library_index`, and `library_recommend` all work without an OpenAI key.

#### Pointing roles at a gateway instead of OpenAI directly

Every LLM/embedding call (routing in `library_ask`, embeddings in `library_ingest`) goes through a small per-role provider table (`src/utils/providers.ts`, THE-318) instead of talking to OpenAI's SDK directly. There are five roles: `router`, `synth`, `research`, `embeddings`, `rerank`. Each is resolved from env in this order:

1. `ALEXANDRIA_<ROLE>_BASE_URL`, `ALEXANDRIA_<ROLE>_API_KEY`, `ALEXANDRIA_<ROLE>_MODEL` (per-role overrides; `<ROLE>` is the role name upper-cased, e.g. `ALEXANDRIA_ROUTER_BASE_URL`)
2. `ALEXANDRIA_BASE_URL`, `ALEXANDRIA_API_KEY` (shared defaults across every role)
3. `OPENAI_API_KEY`, with `baseURL` defaulted to `https://api.openai.com/v1`

With only `OPENAI_API_KEY` set, every role resolves through step 3, which is exactly today's behavior (`gpt-4o-mini` for `router`/`synth` against `api.openai.com`, `text-embedding-3-small` for `embeddings`).

To route every role through a LiteLLM gateway instead:

```env
ALEXANDRIA_BASE_URL=http://100.78.123.100:4001/v1
ALEXANDRIA_API_KEY=sk-litellm-...
```

To route through Cloudflare AI Gateway (its OpenAI-compatible endpoint):

```env
ALEXANDRIA_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai
ALEXANDRIA_API_KEY=<your OpenAI key, forwarded through the gateway>
```

Or point just one role at a gateway while the rest stay on OpenAI directly, e.g. `ALEXANDRIA_ROUTER_BASE_URL` + `ALEXANDRIA_ROUTER_API_KEY` for routing only.

When `ALEXANDRIA_<ROLE>_BASE_URL`/`ALEXANDRIA_BASE_URL` is set *and* `OPENAI_API_KEY` is also present, `OPENAI_API_KEY` is wired up as a one-shot fallback: a network error or 5xx from the gateway falls through to a direct OpenAI call once before the request fails. `chatJSON` (used by routing) always validates the model's response against a zod schema and retries once, on the same backend, with the validation error appended to the prompt, which helps when a gateway is proxying a smaller or local model that doesn't reliably follow the JSON contract on the first try. It requests `response_format: json_object` only against `api.openai.com`, or when `ALEXANDRIA_<ROLE>_JSON_MODE=1` confirms the gateway/model supports it; otherwise it asks for JSON in the prompt instead.

### Supabase — optional ([supabase.com](https://supabase.com/dashboard))

Required by one tool only:

- **`library_ingest`** — writes chunked, embedded text into a pgvector table for semantic search. Without this, retrieved texts stay in-context and are not persisted anywhere.

Everything else — searching, reading, browsing, getting recommendations — queries external sources in real time and needs no database.

### Source-specific keys

Some sources require their own API key. These are free registrations. Sources without a key listed here work without any credentials.

| Env Var | Source(s) | Get It |
|---|---|---|
| `CORE_API_KEY` | `core` | [core.ac.uk/services/api](https://core.ac.uk/services/api) |
| `COURTLISTENER_API_KEY` | `courtlistener` | [courtlistener.com/profile/tokens](https://www.courtlistener.com/profile/tokens/) |
| `GOVINFO_API_KEY` | `govinfo`; also accepted by `congress` and `regulations` as a fallback for `DATA_GOV_API_KEY` | [api.data.gov/signup](https://api.data.gov/signup/). Does not cover `smithsonian`, which needs its own `SMITHSONIAN_API_KEY` from the same signup page |
| `GOOGLE_BOOKS_API_KEY` | `googlebooks` | [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Books API |
| `BHL_API_KEY` | `bhl` | [biodiversitylibrary.org/getapikey](https://www.biodiversitylibrary.org/getapikey.aspx) |
| `DIGITALNZ_API_KEY` | `digitalnz` | [digitalnz.org/developers](https://digitalnz.org/developers) |
| `DPLA_API_KEY` | `dpla` | [pro.dp.la/developers/api-codex](https://pro.dp.la/developers/api-codex) |
| `EUROPEANA_API_KEY` | `europeana` | [apis.europeana.eu](https://apis.europeana.eu/en/) — test key immediate, personal ~1 week |
| `GITHUB_TOKEN` | required by `githubsearch` and `githubmcp`; optional for `ghsa` and `openiti` | [github.com/settings/tokens](https://github.com/settings/tokens), public repo read scope. `githubsearch` and `githubmcp` are hidden without it; `ghsa` falls back to 60s pacing and `openiti` to an unauthenticated search path |
| `NASA_ADS_API_KEY` | `nasaads` | [ui.adsabs.harvard.edu/user/settings/token](https://ui.adsabs.harvard.edu/user/settings/token) |
| `SPRINGER_OA_API_KEY` + `SPRINGER_META_API_KEY` | `springer` | [dev.springernature.com](https://dev.springernature.com/) — same registration, two keys |
| `ZENODO_API_KEY` | `zenodo` | [zenodo.org/account/settings/applications/tokens/new](https://zenodo.org/account/settings/applications/tokens/new/) — optional, increases rate limits |
| `SMITHSONIAN_API_KEY` | `smithsonian` | [api.data.gov/signup](https://api.data.gov/signup/). Its own key, separate from `GOVINFO_API_KEY` |
| `SEMANTIC_SCHOLAR_API_KEY` | `semanticscholar` | [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) — optional, increases rate limits |
| `TROVE_API_KEY` | `trove` | [trove.nla.gov.au/about/create-something/using-api](https://trove.nla.gov.au/about/create-something/using-api) — ~1 week approval |
| `YOUTUBE_API_KEY` | `youtube` | [console.cloud.google.com](https://console.cloud.google.com/) — enable YouTube Data API v3; search only, transcripts need no key |

## Setup

```bash
git clone https://github.com/The-40-Thieves/alexandria-mcp
cd alexandria-mcp
npm install
npm run build
```

Copy `.env.example` to `.env`. Minimum configuration to run with no credentials (search and read only):

```env
TRANSPORT=stdio
```

To enable `library_ask`:

```env
TRANSPORT=stdio
OPENAI_API_KEY=sk-...
```

To enable `library_ingest`:

```env
TRANSPORT=stdio
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

## Supabase Schema

Required only if using `library_ingest`:

```sql
create table if not exists knowledge_chunks (
  id bigserial primary key,
  content text not null,
  embedding vector(1536),
  mcp_name text,
  metadata jsonb,
  created_at timestamptz default now()
);

create table if not exists source_docs (
  id bigserial primary key,
  source_url text not null,
  mcp_name text not null,
  title text,
  source text,
  chunk_count int,
  indexed_at timestamptz,
  unique (source_url, mcp_name)
);

create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

## Claude Desktop (stdio)

Minimum config (search and read only):

```json
{
  "mcpServers": {
    "library": {
      "command": "node",
      "args": ["/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

With `library_ask` and `library_ingest` enabled:

```json
{
  "mcpServers": {
    "library": {
      "command": "node",
      "args": ["/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "OPENAI_API_KEY": "sk-...",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
      }
    }
  }
}
```

## Railway (HTTP)

HTTP mode is off by default. Set `TRANSPORT=http` to serve Streamable HTTP on
`/mcp` instead of speaking stdio, and `PORT` to choose the listen port
(default `3000`; Railway sets `PORT` for you). Every request gets its own MCP
server and transport, so the endpoint is stateless and safe to run behind a
load balancer.

| Env Var | Values | Default |
|---|---|---|
| `TRANSPORT` | `stdio` or `http` | `stdio` |
| `PORT` | any port number, HTTP mode only | `3000` |

Speaks the 2025-era MCP protocol on the wire (the `@modelcontextprotocol/*` v2
SDK's default for a hand-wired `NodeStreamableHTTPServerTransport` /
`StdioServerTransport`, which is what `src/index.ts` uses). Opting into the
2026-07-28 revision is a server-construction change, not a config flag: swap
the HTTP handler for `createMcpHandler(factory, { legacy: 'stateless' | 'reject' })`
and the stdio one for `serveStdio(factory, { legacy: 'reject' })`, both from
`@modelcontextprotocol/server`.

Set those (plus any source keys) in the Railway dashboard and deploy:

```bash
railway up
```

Locally the same thing is:

```bash
TRANSPORT=http PORT=3000 npm start
```

Register in Claude Desktop:

```json
{
  "mcpServers": {
    "library": {
      "url": "https://your-service.up.railway.app/mcp"
    }
  }
}
```

Health check: `GET /health` returns `{ status: "ok", version: "10.0.0", sources: { total: 152, visible: 116, hidden: 36, calls: 0, errors: 0 }, byKind: { rest: 118, hub: 0, rss: 22, mcp: 6, scrape: 6 }, quota: { day: "2026-09-02", reserved: 0, sources: 0, backend: "state" }, cache: { entries: 0 }, tools: 10 }`.

Metrics: `GET /metrics` returns per-source counters (calls, errors, timeouts, cacheHits, quotaRejections, latencyMsTotal) and per-tool counters (invocations, llmCalls) as JSON, e.g. `{ "sources": { "arxiv": { "calls": 12, "errors": 0, "timeouts": 0, "cacheHits": 3, "quotaRejections": 0, "latencyMsTotal": 4210 } }, "tools": { "library_ask": { "invocations": 5, "llmCalls": 5 } } }`. Only sources/tools actually called since the process started appear.

## Adding Custom Providers

The pipeline is provider-agnostic. To add a new embedding model or vector store:

1. Implement `EmbeddingProvider` or `VectorStoreProvider` from `src/types.ts`
2. Add your implementation to `src/pipeline/providers/`
3. Register it in `src/pipeline/providers/index.ts`
4. Set `EMBEDDING_PROVIDER` or `VECTOR_STORE_PROVIDER` in your env

```typescript
// Example: Ollama embedding provider
import type { EmbeddingProvider } from '../../types.js';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;

  async embed(texts: string[]): Promise<number[][]> {
    // your implementation
  }
}
```
