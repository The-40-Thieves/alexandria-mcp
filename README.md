# Alexandria

[![npm version](https://img.shields.io/npm/v/@the-40-thieves/alexandria-mcp.svg)](https://www.npmjs.com/package/@the-40-thieves/alexandria-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=alexandria&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0aGUtNDAtdGhpZXZlcy9hbGV4YW5kcmlhLW1jcCJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=alexandria&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40the-40-thieves%2Falexandria-mcp%22%5D%7D)
[Install in Goose](goose://extension?cmd=npx&arg=-y&arg=%40the-40-thieves%2Falexandria-mcp&id=alexandria&name=Alexandria&description=Query%2C%20read%2C%20and%20ingest%20texts%20from%20152%20public%20digital%20libraries)

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
| `library_citations(id, source, direction, limit?, format?)` | List the works an item cites (`direction: "references"`) or the works that cite it (`direction: "citations"`), via OpenAlex's citation graph with OpenCitations as a fallback; `format: "bibtex" \| "ris" \| "apa"` also returns a `formatted` bibliography string |

`library_ask` is the primary entry point. `library_search` is for targeted queries against a known source. `library_index` / `library_ingest` are for building a vector knowledge base from retrieved texts. `library_answer` and `library_research` synthesize a cited answer or report instead of returning raw results. `library_health_check` tells you whether a source is worth calling before you call it. `library_citations` walks the citation graph around an item and can export it as a bibliography.

`library_ask`, `library_search`, `library_answer`, `library_research`, `library_health_check`, and `library_citations` take a `response_format: "concise" | "detailed"` parameter (default `concise`); concise trims results and citations to the high-signal fields (title, source, id, year, hasFullText, url; answer/report + citations; name, cluster, status), detailed returns the full payload, including routing reasons, relevance scores, per-stage diagnostics, and per-source error rate/latency/quota usage. In `detailed` mode, `library_search` also attaches a `resource_link` content item for each full-text result, pointing at that item's `library://doc/{source}/{id}` resource (see below): a client with resource support can read the full text directly instead of a second `library_read` call.

## Prompts

Three ready-made research workflows, surfaced by MCP clients as slash commands (Claude Code's `/alexandria:<name>`, VS Code's `/alexandria.prompt`). Each returns a single message naming the tools to call, in order. It does not call any tool itself.

| Prompt | Description |
|---|---|
| `literature_review(topic, depth?)` | Survey a topic across sources and produce a cited report |
| `fact_check_claim(claim)` | Check one claim against the library and report whether it is supported |
| `verify_bibliography(references)` | Check that a list of references (one per line) resolves to real, findable items |

## Resources

`library://doc/{source}/{id}` reads the same text `library_read(id, source)` returns (including the open-access fallback below), addressed by the `source`/`id` pair `library_search` or `library_ask` returned. Clients that support MCP resources (Claude Code's `@srv:uri`, VS Code's Add Context) can pull an item's full text directly.

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

See [docs/cloudflare.md](docs/cloudflare.md) for the fuller Cloudflare integration guide: AI Gateway's newer unified endpoint, Workers AI for the `embeddings`/`rerank` roles, Tunnel + Access for a private `/mcp`, WAF rate limiting for a public one, R2 as an optional cache store, the Browser Run fetch tier below, and why Alexandria stays a hybrid (Node core, Cloudflare services) rather than a full Workers port.

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

## Privacy Policy

Alexandria has no telemetry of its own: it runs on infrastructure you
control, and nothing about your queries, results, or credentials is sent to
the Alexandria project.

- Queries go to the upstream public library sources the agent selects for a
  given request, using each source's own public API under that source's own
  terms.
- `library_ask`, `library_answer`, `library_research`, and `library_ingest`,
  when an OpenAI (or OpenAI-compatible gateway) key is configured, also send
  your query text and retrieved excerpts to the LLM and embeddings provider
  the operator set up. See [docs/cloudflare.md](docs/cloudflare.md) for the
  Cloudflare AI Gateway routing path and
  [docs/fetch-tier-runtime.md](docs/fetch-tier-runtime.md) for how outbound
  fetches to library sources are guarded.
- Nothing is stored by the project itself. The operator's own `data/`
  directory holds local caches (state DB, per-process read cache) on the
  machine running the server, and nowhere else.

Full text: [PRIVACY.md](PRIVACY.md).

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

create index if not exists knowledge_chunks_embedding_hnsw_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);
```

If you set this schema up before Task 12, you had an `ivfflat` index instead
(`knowledge_chunks_embedding_idx`) - `docs/sql/match_chunks.sql` drops it and
creates the `hnsw` one shown above, since HNSW builds incrementally and needs
no `lists` tuning constant as the table grows. If corpus-as-cache hits seem to
be missing results a plain `<=>` scan would have found, raise the query-time
`hnsw.ef_search` session setting (default 40) at the cost of a slower query -
see the commented recommendation in `docs/sql/match_chunks.sql`.

### Corpus as cache

`library_answer` can also read straight from `knowledge_chunks` - previously
ingested text, already embedded - as one more ranked list next to the live
per-source search, skipping the network entirely for a hit it already has
the full text for. This only ever serves chunks from a source whose registry
freshness is `static` or `daily` (never `realtime`), and only above
`ALEXANDRIA_CORPUS_MIN_SIM` cosine similarity (default `0.92`).

It needs one more piece of schema beyond the table above: run
`docs/sql/match_chunks.sql` in the Supabase SQL editor. It defines
`match_knowledge_chunks()`, the nearest-neighbor search function
`SupabaseVectorStoreProvider.query()` calls via `.rpc()`, and the `hnsw`
index above. This file was written against the current pgvector/supabase-js
docs but has not been run against a live database - verify it against your
own project before relying on it.

## Claude Code (npx)

```bash
claude mcp add --env OPENAI_API_KEY=sk-... alexandria -- npx -y @the-40-thieves/alexandria-mcp
```

Search and read work with no environment variables at all; the `--env` flag
above is only needed to enable `library_ask`, `library_answer`,
`library_research`, and `library_ingest`. See [Credentials](#credentials)
for the full list of optional keys.

## Claude Desktop (stdio)

Minimum config (search and read only), using the published package via `npx`:

```json
{
  "mcpServers": {
    "library": {
      "command": "npx",
      "args": ["-y", "@the-40-thieves/alexandria-mcp"],
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
      "command": "npx",
      "args": ["-y", "@the-40-thieves/alexandria-mcp"],
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

From a local checkout instead of the published package, replace `command`/
`args` with `"command": "node", "args": ["/path/to/alexandria-mcp/dist/index.js"]`.

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

`/mcp` (only) is guarded: DNS-rebinding-safe Host/Origin validation
(`ALEXANDRIA_ALLOWED_ORIGINS`, a comma-separated hostname list - loopback
is always allowed regardless) and a per-client-IP rate limit
(`ALEXANDRIA_HTTP_RATE_LIMIT`, default 60/minute, `429` with a JSON-RPC
error body once exceeded). See `docs/fetch-tier-runtime.md` for the
details and `src/httpGuards.ts` for the implementation.

**Set `ALEXANDRIA_ALLOWED_ORIGINS` on any deployment reachable by a
hostname other than loopback.** With it unset, `Host`-header validation is
**off** and the server logs one warning at startup saying so: a deployment's
`Host` header is its own hostname, which cannot be in an allowlist that does
not exist, so enforcing the check without one would `403` every request.
Setting it is what turns DNS-rebinding protection on. The `Origin` check is
unconditional either way, so a browser request carrying an `Origin` outside
the list is always rejected.

`POST /mcp` requires `content-type: application/json` (anything else is
`415`) and a body no larger than 100 KiB (`413`, connection closed).

Behind a reverse proxy or PaaS edge (Cloudflare Tunnel, Railway's own edge,
...) the rate limiter's per-client key defaults to `req.socket.remoteAddress`,
which is the proxy's address for every caller, not the caller's - set
`ALEXANDRIA_TRUSTED_PROXY=1` to key on `CF-Connecting-IP` (falling back to
the *rightmost* `X-Forwarded-For` entry, the one appended by the last hop;
the leftmost entry is whatever the original caller sent) instead. Only set this once `/mcp` is
reachable exclusively through a proxy you trust to set those headers
honestly - see `docs/cloudflare.md`'s Tunnel and Access section.

Serves both eras of the MCP protocol on the same `/mcp` endpoint:
`createMcpHandler(factory, { legacy: 'stateless' })` (`@modelcontextprotocol/server`,
adapted to `node:http` by `toNodeHandler()` from `@modelcontextprotocol/node`)
answers a 2026-07-28 `server/discover` probe or per-request envelope on the
modern path, and falls back to the same stateless idiom the pre-2026 SDK used
for a 2025-era `initialize` handshake. One `createServer()` factory backs
both. stdio uses the connection-pinned `serveStdio(factory)` from
`@modelcontextprotocol/server/stdio`, which selects the era from the
connection's opening exchange. Note: the 2025-era fallback path answers over
`text/event-stream` (SSE) rather than a bare JSON body, since the SDK exposes
no equivalent to v1's `enableJsonResponse` for that path. Any MCP client
built on a Streamable HTTP transport (the SDK's own `StreamableHTTPClientTransport`
included) already parses either format transparently.

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

Health check: `GET /health` returns `{ status: "ok", version: "11.0.0", sources: { total: 152, visible: 116, hidden: 36, calls: 0, errors: 0 }, byKind: { rest: 118, hub: 0, rss: 22, mcp: 6, scrape: 6 }, quota: { day: "2026-09-02", reserved: 0, sources: 0, backend: "state" }, cache: { entries: 0 }, tools: 11 }`.

Metrics: `GET /metrics` returns per-source counters (calls, errors, timeouts, cacheHits, quotaRejections, latencyMsTotal) and per-tool counters (invocations, llmCalls) as JSON, e.g. `{ "sources": { "arxiv": { "calls": 12, "errors": 0, "timeouts": 0, "cacheHits": 3, "quotaRejections": 0, "latencyMsTotal": 4210 } }, "tools": { "library_ask": { "invocations": 5, "llmCalls": 5 } } }`. Only sources/tools actually called since the process started appear.

## Install in other clients

All of these run the published package via `npx`; search and read work with
no environment variables, and `--env`/env block additions enable
`library_ask`, `library_answer`, `library_research`, and `library_ingest` the
same way the Claude Code and Claude Desktop sections above do.

**GitHub Copilot** - `.vscode/mcp.json`:

```json
{
  "servers": {
    "alexandria": {
      "command": "npx",
      "args": ["-y", "@the-40-thieves/alexandria-mcp"]
    }
  }
}
```

**Windsurf** - `mcp_config.json`:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "npx",
      "args": ["-y", "@the-40-thieves/alexandria-mcp"]
    }
  }
}
```

**Codex CLI**:

```bash
codex mcp add alexandria -- npx -y @the-40-thieves/alexandria-mcp
```

**OpenCode** - `opencode.json`:

```json
{
  "mcp": {
    "alexandria": {
      "type": "local",
      "command": ["npx", "-y", "@the-40-thieves/alexandria-mcp"]
    }
  }
}
```

**Amazon Q** - `~/.aws/amazonq/mcp.json` (global) or `q mcp add`:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "npx",
      "args": ["-y", "@the-40-thieves/alexandria-mcp"]
    }
  }
}
```

**Kiro** - `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "npx",
      "args": ["-y", "@the-40-thieves/alexandria-mcp"]
    }
  }
}
```

**Gemini CLI**:

```bash
gemini extensions install https://github.com/The-40-Thieves/alexandria-mcp
```

**Continue** - add to the `mcpServers` array in your Continue config:

```json
{
  "name": "alexandria",
  "command": "npx",
  "args": ["-y", "@the-40-thieves/alexandria-mcp"]
}
```

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
