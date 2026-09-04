# Changelog

## 11.0.0 - 2026-09-03

### Added

- Server instructions: the MCP `initialize` response now carries an
  `instructions` block that tells clients which tool to reach for first
  (`library_ask`), when to use the targeted and synthesis tools, and how the
  `response_format` parameter works. (Task 1)
- `outputSchema` on every tool, so clients can validate and render structured
  results instead of parsing free text. (Task 1)
- `response_format: "concise" | "detailed"` on `library_ask`,
  `library_search`, `library_answer`, `library_research`, and
  `library_health_check`. `concise` is the default and trims results and
  citations to the high-signal fields; `detailed` returns the full payload
  including routing reasons, scores, per-stage diagnostics, and per-source
  error rate, latency, and quota usage. (Task 1)
- Progress notifications on `library_answer` and `library_ingest`, emitted
  when the client supplies a `progressToken`. (Task 1)
- `library_health_check(source?, cluster?)`: reports per-source health
  (`ok`, `degraded`, `down`, `key_missing`, `unknown`), merging this
  process's live error rate and latency with the last off-process probe run.
  Tool count goes from 9 to 10 at this point; `library_citations` lands in a
  later task for 11. (Task 2)
- A per-process read cache keyed by source freshness: repeated
  `library_read` calls for the same item within a source's freshness window
  are served from memory instead of refetching. (Task 2)
- `ingestPolicy` on every source (allowed, attribution, timeboxed,
  forbidden), surfaced in `library_list_sources` and `docs/sources.md`.
  `library_ingest` refuses forbidden and timeboxed sources (the latter
  unless `ALEXANDRIA_INGEST_TIMEBOXED=1`) and stamps license, attribution,
  and expiry metadata on chunks. (Task 3)
- Eight new sources with fixture tests and golden queries: wikipedia
  (search and read, CC BY-SA attribution), wikidata (entity search),
  crossref (works search, DOI read with references and BibTeX by content
  negotiation, polite pool via `CONTACT_EMAIL`), pubmed (E-utilities, PMC
  BioC full text when a PMCID exists), medrxiv, secedgar (full-text search,
  filing read through the guarded fetch tier, identified User-Agent),
  worldbank (indicator search and recent series), and datacite (dataset DOI
  search). (Task 4)
- Seven more new sources with fixture tests and golden queries: hal (Solr
  search, PDF links), hansard (UK debates), eurlex (CELLAR), bls (Public
  Data API v2, free key optional), dblp, opencitations (citations and
  references by DOI, also the fallback for `library_citations`), and
  readthedocs (server-side search v3 with a `project:` prefix). (Task 5)
- A PDF tier in the fetch chain (`unpdf`) with per-page text and page
  anchors on `ReadResult.pages`. An open-access fallback chain for
  metadata-only reads that carry a DOI: OpenAlex's best OA location, then
  PMC BioC full text, then CORE (with a key), then fatcat's archived PDF;
  every hop passes the SSRF guard. (Task 6)
- `library_citations(id, source, direction, limit?, format?)` (tool 11):
  resolves a seed `(id, source)` to a DOI or OpenAlex id, walks `references`
  (batched `referenced_works`) or `citations` (`works?filter=cites:`), with
  OpenCitations as the fallback when OpenAlex has no record.
  `format: "bibtex" | "ris" | "apa"` returns a bibliography for the seed and
  results, preferring Crossref content negotiation for BibTeX when a DOI
  exists. Tool count goes from 10 to 11. (Task 7)
- `npm run eval:answer`: runs `library_answer` over a 20-question golden set
  (`eval/answer-golden.yaml`) and scores citation precision, nugget recall,
  and URL/DOI resolvability; prints a table and a machine-readable last
  line. `docs/answer-eval.md` records the first baseline. (Task 8)
- A `verify` provider role (falls back to the synth provider): each cited
  sentence is checked against its cited chunk with a warrant-strength
  rubric, unsupported markers are removed, and over-strength claims are
  warned. URL and DOI liveness checks (24h cache, at most 20 per answer) set
  `citations[].resolves`. Citation grades A to D from source tier,
  retraction status (OpenAlex batch lookup), citation counts, year, full-text
  verification, and the research chain check; retracted work is graded D
  with a warning. Citations now carry a `url` field. (Task 9)
- `rerank()` with three backends behind one interface: `llm` (listwise over
  a shuffled top 20), `cohere` (Cohere-shape `/rerank`), and `workers-ai`
  (Cloudflare bge-reranker-base shape). `ALEXANDRIA_RERANK` selects
  `off | llm | cohere | workers-ai`; `ALEXANDRIA_RERANK_POOL` (default 60)
  bounds the RRF pool passed to the reranker. Margin-gated multi-query in
  `library_ask` (`ALEXANDRIA_MULTI_QUERY=1`, off by default): two alternate
  phrasings from the router role when stage-1 margin is below the skip
  margin. (Task 10)
- `library_research` outlines 3 to 7 coverage objectives before round 1,
  marks them covered after each round, and stops when all are covered or
  the existing depth, breadth, and time limits run out; `objectives` and
  `coverage` appear in detailed output. Chunks embed with a title and
  section-heading prefix (`ALEXANDRIA_CHUNK_PREFIX=off` disables it). OCR
  quality is now the minimum of the clean-character ratio and a lexicon-hit
  ratio over a bundled 5,000-word list. (Task 11)
- `VectorStoreProvider.query()` and a `match_knowledge_chunks` SQL function
  with an HNSW index (`docs/sql/match_chunks.sql`; replaces ivfflat).
  **`docs/sql/match_chunks.sql` has not been verified against a live
  database.** Run it on a staging project first: it drops and recreates the
  index, and an HNSW build over an existing corpus is neither instant nor
  free.
  `corpusSearch()` embeds the query and returns already-ingested chunks
  above `ALEXANDRIA_CORPUS_MIN_SIM` (default 0.92) for static and daily
  sources only, folded into `library_answer` as one more fused list;
  `readTopSources` skips the adapter read for corpus hits. (Task 12)
- Origin and host-header validation plus a per-client-IP token bucket on
  `/mcp` (`ALEXANDRIA_ALLOWED_ORIGINS`, `ALEXANDRIA_HTTP_RATE_LIMIT`,
  default 60 per minute). (Task 13)
- Three prompts, surfaced by MCP clients as slash commands:
  `literature_review(topic, depth?)`, `fact_check_claim(claim)`, and
  `verify_bibliography(references)`. A `library://doc/{source}/{id}`
  resource template returning read text through the same open-access
  fallback as `library_read`; search results in detailed mode carry
  `resource_link` items for full-text results. (Task 14)
- `docs/cloudflare.md`: the hybrid verdict on why the Node core stays off
  Workers, env-only recipes for AI Gateway on the LLM roles, Workers AI
  bge-m3 embeddings and the bge-reranker-base backend, Tunnel plus Access
  for a private `/mcp` and WAF rate limiting for a public one, R2 as an
  optional text store, and what a full port would cost. A fourth fetch
  tier, Cloudflare Browser Run's REST `/markdown`, used only when
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_RUN_TOKEN` are set; the
  target passes the SSRF guard first and the response is capped.
  `ALEXANDRIA_TRUSTED_PROXY=1`: the `/mcp` rate limiter keys on
  `CF-Connecting-IP`, then the rightmost `X-Forwarded-For` entry, else the
  socket address; off by default. (Task 15)

### Changed (BREAKING)

- `/mcp` Host-header validation now applies only when
  `ALEXANDRIA_ALLOWED_ORIGINS` is set, or when the request arrived on a
  loopback interface. Applied unconditionally it returned `403` for every
  request to any non-loopback deployment that had not set the variable,
  because such a deployment's own `Host` header is in no allowlist when
  there is no allowlist. Remedy: set `ALEXANDRIA_ALLOWED_ORIGINS` to the
  hostname(s) this deployment is reached by, which restores Host validation
  everywhere and is what the startup warning now asks for. The `Origin`
  check is unchanged and still rejects any request whose `Origin` header
  names a hostname outside the list.
- `POST /mcp` with a media type other than `application/json` is now
  answered `415` by this server, and any POST body over the 100 KiB cap is
  answered `413` (it was `500`) with the connection closed. Previously a
  non-JSON POST skipped the cap entirely and the SDK buffered the whole
  request before answering.

### Changed

- Tool descriptions describe what a tool does and when to call it; the
  return-shape prose that used to live in descriptions moved into each tool's
  `outputSchema` and the server instructions. (Task 1)
- The default response for the five tools above is now `concise`; callers
  that depended on the previous full payload must pass
  `response_format: "detailed"`. This is the breaking change behind the major
  version bump. (Task 1)
- The Papers with Code description now states it queries the community
  mirror at paperswithcode.co; CourtListener's daily cap is now 125. (Task 3)
- `ReadResult.unavailable` now carries a discriminated reason and the tiers
  tried, instead of an empty string. (Task 6)
- HTML extraction (linkedom plus Defuddle) now runs in a
  `node:worker_threads` worker with a 30 second job timeout and an in-thread
  fallback, so a concurrent `/health` answers within tens of milliseconds
  during a multi-second extraction instead of blocking. The defuddle tier
  now asks for `text/markdown` first and uses a markdown response directly.
  The fetch User-Agent is now honest (`Alexandria/<version> (+repo)`, with
  an `ALEXANDRIA_FETCH_UA` override) instead of impersonating a browser.
  (Task 13)
- `/mcp` is now served by `createMcpHandler` with a legacy stateless
  fallback, so one endpoint speaks both the 2026-07-28 protocol and the
  earlier one; stdio uses the same server factory. (Task 14)

### Removed

- Return-shape documentation from tool description strings (superseded by
  `outputSchema`). (Task 1)
- HathiTrust (its Data API was retired 2024-07-17). (Task 3)
- SciELO, added then dropped in the same task after both upstreams were
  verified unusable for live search (a JS proof-of-work bot shield on
  search.scielo.org, no text search in ArticleMeta). (Task 5)
- The dedicated GitHub Packages publish workflow (`npm.pkg.github.com`);
  releases now publish to npmjs.org with provenance instead. (Task 16)

### Fixed

- (none recorded for Tasks 1 through 15.)

## 10.0.0

Alexandria v2: a ground-up rebuild of the source registry and routing layer,
landed across ten staged PRs. Nine public tools, 138 sources.

- **Registry v2** (Stage 0-1): every adapter now carries `kind`, `cluster`,
  `freshness`, `auth`, and `pacing` metadata. A shared guard layer wraps every
  `search`/`read` call with a result cache, a per-source daily quota ledger,
  pacing, and a call timeout, so no adapter has to implement its own.
- **33 repaired sources, new baseline** (Stage 2): audited and fixed every
  source carried over from v1, with keys and pacing recorded honestly in the
  registry instead of assumed.
- **RSS kind** (Stage 3): a `defineRssSource` helper and 17 RSS feeds, plus
  Google News search and NHK.
- **49 new adapters** (Stage 4A/4B): security, developer, and standards
  clusters (25 sources), then markets, economics, real estate, news,
  geopolitical, government, and AI research (24 sources).
- **MCP delegation kind** (Stage 5): six sources that proxy a call through
  another MCP server instead of a direct HTTP request (huggingface,
  context7mcp, jina, jinaarxiv, githubmcp, mdnmcp).
- **Web tier with SSRF hardening** (Stage 6): a fetch chain (defuddle, then
  jina reader, then crawl4ai, whichever is configured) behind an SSRF guard,
  plus searxng, jina search, tavily, and a read-only `webfetch` source.
- **Per-role provider table** (Stage 7): every LLM/embedding call goes
  through one small provider table (`router` / `synth` / `research` /
  `embeddings` / `rerank`), each resolvable to OpenAI directly or to a
  gateway, independently, from env alone.
- **Two-stage router with eval** (Stage 8): an embedding-first candidate
  stage (or BM25 when no embeddings role is configured) feeding a router LLM
  pick, scored against a hand-written golden set (`npm run eval:routing`).
- **`library_answer` and `library_research`** (Stage 9): a cited-answer tool
  (reciprocal rank fusion across routed sources, inline `[n]` citations,
  uncited-sentence dropping) and a recursive multi-round research tool built
  on top of it. Nine public tools total.
- **Generated docs, weekly probe workflow** (Stage 10, this release):
  `npm run docs` generates `docs/sources.md` and the source/env sections of
  `README.md` / `.env.example` from the live registry, checked in CI
  (`npm run docs -- --check`). `/health` now reports version, visible/hidden
  counts, and a per-kind breakdown. A weekly GitHub Actions workflow runs
  `npm run probe` against every source and files an issue on regression.

### Known limitations

- The embeddings gate (`library_ask`/`library_answer` stage-1 ranking
  quality, `library_ingest`) needs an `embeddings`-role key configured; a
  deployment with none falls back to BM25-only routing.
- YouTube transcripts are blocked from most datacenter IPs unless
  `SUPADATA_API_KEY` is set; without it, the fallback transcript path is
  best-effort only.
- 28 of the 138 registered sources are hidden pending a key or config not
  present in this deployment (see `docs/sources.md` for the list).
- The MCP SDK v2 migration is deferred; this build stays on
  `@modelcontextprotocol/sdk` ^1.30 per the plan's global constraints.
