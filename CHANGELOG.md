# Changelog

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
- **RSS kind** (Stage 3): a `defineRest` helper and 17 RSS feeds, plus Google
  News search and NHK.
- **50 new adapters** (Stage 4A/4B): security, developer, and standards
  clusters (25 sources), then markets, economics, real estate, news,
  geopolitical, government, and AI research (24 sources).
- **MCP delegation kind** (Stage 5): sources that proxy a call through another
  MCP server instead of a direct HTTP request (huggingface, context7, jina,
  github, mdn).
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
