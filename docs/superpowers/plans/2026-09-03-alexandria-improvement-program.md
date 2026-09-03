# Alexandria improvement program (2026-09-03)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. One implementer per task, one reviewer per task, squash-merge per task. Steps use checkbox (`- [ ]`) syntax for tracking in the ledger.

**Goal:** Land the ranked recommendations of the 2026-09-03 improvement brief, plus the four vault ideas that survived evidence review, as sixteen reviewed, gated, squash-merged PRs on `The-40-Thieves/alexandria-mcp` main, ending with a release-ready tree whose tag and publish is the final, separately confirmed move.

**Architecture:** Alexandria stays one monolithic Node 24 MCP server (the 2026-05-20 vault decision), stateless per request, with the guard layer in `src/sources/registry.ts` wrapping every source. Cloudflare is consumed as services from Node (AI Gateway, Workers AI, Browser Run, Tunnel and Access), not as a host: the deep dive found `node:sqlite` is a stub on Workers and undici dispatchers are not honoured there, which would weaken the SSRF pin. New capability lands as additive fields and tools; defaults change only where the brief names it (`response_format` defaults to `concise`).

**Tech stack:** TypeScript 7, Node 24 native TS, `@modelcontextprotocol/server` v2, undici 7, `node:sqlite`, zod 4, pino, node:test, biome, knip.

**Spec:** the brief (artifact https://claude.ai/code/artifact/b47fa005-3eac-4ab1-8387-ab3f1df6ac16, copy at `.superpowers/sdd/2026-09-03-alexandria-improvement-program/research/brief.html`) and the research reports under `.superpowers/sdd/2026-09-03-alexandria-improvement-program/research/` (`competitors.md`, `mcp-ecosystem.md`, `retrieval-sota.md`, `source-coverage.md`, `vault-ideas-verdicts.md`, `cloudflare-platform.md`, `codemap.md`). Baseline at main 2b8b3a3: 967 tests, gate 84 s, 138 sources (103 visible), 9 tools, stage-1 nDCG@5 0.910 with embeddings, probe 96 OK.

## Global Constraints

- Gate before every commit that ends a task: `npm run gate` (typecheck, build, test, biome, knip) and `npm run docs -- --check`, both exit 0. Quote the test count in the report. Capture exit codes; never pipe a gate into grep to decide pass or fail. Run every repo command through `mise exec --` (the interactive PATH resolves node to 26; the repo pins 24).
- Every commit is DCO-signed (`git commit -s`). Conventional-commit subjects.
- No em dashes anywhere: code, comments, docs, commit messages.
- Never log or return credential values. Error strings may include URLs after `redactUrl`.
- The SSRF guard in `src/web/fetchTier.ts` (`assertFetchableUrl`, redirect re-validation, address pinning through `guardedDispatcher`) keeps its behaviour exactly. Every new outbound fetch of a caller-supplied URL goes through it.
- Runtime dependencies may be added only where a task names them: `unpdf` (Task 6). Nothing else. Dev dependencies: none.
- Test runner stays `node:test`. New tests mock the network with the `stubFetch` pattern in `src/sources/kinds/rest.test.ts`; no unit test may reach a live endpoint. Live measurements (probe, evals) are recorded in the task report, not asserted in tests.
- Before writing code against a library or runtime API, fetch its current docs with `npx ctx7@latest library "<name>" "<question>"` then `npx ctx7@latest docs <id> "<question>"`. Applies to the MCP SDK v2 (`registerTool` `outputSchema`, `instructions`, `registerPrompt`, `registerResource`, `createMcpHandler`, `toNodeHandler`), zod 4, `node:worker_threads`, `unpdf`, and every upstream API a new adapter calls.
- Adding a tool trips four things at once: `TOOL_COUNT` in `src/index.ts:35`, the README tools table, `docs` generation, and `src/index.test.ts`. Do all four in the same commit.
- Docs that count things (README source counts, `docs/sources.md`, `.env.example`) are generated: run `npm run docs`, never edit by hand.
- Branch per task, `imp/task-<N>`, from current main. The controller opens the PR, reviews, and squash-merges before the next task starts; each task starts from the merged main.
- `npm test` writes `eval/probe-latest.json`; do not commit it. Task 16 adds it to `.gitignore`.
- Nothing in Tasks 1 to 15 tags, publishes, or deploys. Task 16 prepares the release; the tag is a separate, confirmed step after it.

## File Structure

New files by task (existing files are named inside each task):
- Task 1: `src/tools/format.ts`, `src/tools/format.test.ts`, `src/instructions.ts`
- Task 2: `src/tools/libraryHealth.ts`, `src/tools/libraryHealth.test.ts`, `src/utils/readCache.ts`, `src/utils/readCache.test.ts`
- Task 3: `src/sources/ingestPolicy.ts`, `src/sources/ingestPolicy.test.ts`
- Task 4: `src/sources/{wikipedia,wikidata,crossref,pubmed,medrxiv,secedgar,worldbank,datacite}.ts` with tests and fixtures under `eval/fixtures/`
- Task 5: `src/sources/{hal,hansard,eurlex,bls,dblp,scielo,opencitations,readthedocs}.ts` with tests and fixtures
- Task 6: `src/web/pdf.ts`, `src/web/pdf.test.ts`, `src/web/openAccess.ts`, `src/web/openAccess.test.ts`
- Task 7: `src/tools/libraryCitations.ts`, `src/tools/libraryCitations.test.ts`, `src/utils/bibliography.ts`, `src/utils/bibliography.test.ts`
- Task 8: `scripts/eval-answer.ts`, `eval/answer-golden.yaml`, `docs/answer-eval.md`
- Task 9: `src/utils/claimCheck.ts`, `src/utils/claimCheck.test.ts`, `src/utils/liveness.ts`, `src/utils/liveness.test.ts`, `src/utils/citationGrade.ts`, `src/utils/citationGrade.test.ts`
- Task 10: `src/utils/rerank.ts`, `src/utils/rerank.test.ts`
- Task 11: none new; `src/tools/libraryResearch.ts`, `src/pipeline/index.ts`, `src/utils/text-clean.ts`
- Task 12: `src/pipeline/corpusSearch.ts`, `src/pipeline/corpusSearch.test.ts`, `docs/sql/match_chunks.sql`
- Task 13: `src/web/extractWorker.ts`, `src/web/extract.ts`, `src/web/extract.test.ts`, `src/httpGuards.ts`, `src/httpGuards.test.ts`
- Task 14: `src/prompts.ts`, `src/prompts.test.ts`, `src/resources.ts`, `src/resources.test.ts`
- Task 15: `docs/cloudflare.md`, `src/web/browserRun.ts`, `src/web/browserRun.test.ts`
- Task 16: `server.json`, `docs/distribution/docker-server.yaml`, `CHANGELOG.md` entry

---

### Task 1: Agent ergonomics: instructions, output schemas, response_format, progress (brief 05, vault idea 10)

**Files:** `src/index.ts`, new `src/instructions.ts`, new `src/tools/format.ts` and test, `src/tools/libraryAsk.ts`, `src/tools/libraryAnswer.ts`, `src/tools/libraryResearch.ts`, `src/index.test.ts`, `README.md` (tools table prose only).

**Interfaces produced:** `formatResult(kind, payload, format: 'concise' | 'detailed')` in `src/tools/format.ts`; `INSTRUCTIONS` string in `src/instructions.ts`; every tool registered with `title`, complete `annotations`, `outputSchema`.

1. Read the SDK v2 docs for `McpServer` options (`instructions`), `registerTool` (`title`, `annotations`, `outputSchema`, `structuredContent` validation) and `notifications/progress`. Note where the SDK validates `structuredContent` against `outputSchema` so a mismatch fails a test, not a client.
2. `src/instructions.ts` exports `INSTRUCTIONS` (under 1,500 characters) built from the text in `research/vault-ideas-verdicts.md` section 10: start with `library_ask`; `library_search` only when a source is named; `library_read(id, source)` for text; `library_answer` and `library_research` for cited output; results are `source:id` pairs; realtime clusters are re-fetched; default responses are concise; ask for `response_format: "detailed"` for routing reasons, scores, grades. Pass it as `instructions` to `new McpServer(...)` at `src/index.ts:68`.
3. Every `registerTool` call gets `title` (human name), full `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`; `library_ingest` is `readOnlyHint: false, destructiveHint: false, idempotentHint: true`), and an `outputSchema` (zod) matching what `structuredContent` returns. Keep the text content block.
4. `response_format: z.enum(['concise', 'detailed']).default('concise')` on `library_ask`, `library_search`, `library_answer`, `library_research`. `src/tools/format.ts`: concise result rows are `{ title, source, id, year, hasFullText, url }`; concise answer is `{ answer, citations }` with routing collapsed to source names; detailed is today's full payload. Implement once; call from each handler. The `outputSchema` for these tools is the detailed shape with every concise-only-absent field optional.
5. Move return-shape prose out of tool descriptions (`library_answer` 915 chars, `library_ask` 709) into `INSTRUCTIONS`; each description keeps what, when, when-not, and parameter notes in 3 to 5 sentences.
6. Progress notifications: factor the `progressToken` block at `src/index.ts:487-492` into a helper `progressReporter(ctx)` and use it from `library_answer` (stages: routed, fetched, read, synthesised) and `library_ingest` (per chunk batch), in addition to `library_research`.
7. Tests: `format.test.ts` asserts concise output keys are a strict subset of detailed for a fixture result; `index.test.ts` asserts `tools/list` returns `title`, `annotations`, and `outputSchema` for all 9 tools and that `initialize` carries `instructions`; a structured-content-against-schema test for `library_search` with a stubbed adapter.
8. `npm run docs`; README tools table gains a `response_format` note.

**Tests:** new `format.test.ts`, extended `index.test.ts`. Gate green.

**Commit:** `feat(mcp): server instructions, output schemas, response_format, progress on answer and ingest`.

---

### Task 2: `library_health_check` tool and a per-process read cache (vault ideas 1 and 7)

**Files:** new `src/tools/libraryHealth.ts` and test, new `src/utils/readCache.ts` and test, `src/sources/registry.ts` (`withGuards.read`), `src/index.ts` (`TOOL_COUNT` 10, registration), `src/index.test.ts`, `README.md`, `scripts/probe.ts` (export the `ProbeResult` type only).

**Interfaces produced:** `libraryHealth({ source?, cluster?, response_format })` returning `{ generatedAt, probeAt?, sources: [{ name, cluster, kind, status: 'ok' | 'degraded' | 'down' | 'key_missing' | 'unknown', errorRate, avgLatencyMs, quotaUsed?, note }] }`; `readCache` in `src/utils/readCache.ts` with `get(source, id)`, `set(source, id, result, ttlMs)`.

1. Health: merge three layers per registered source: static (`hidden`, `auth.env`, `verifiedAt`), process-live counters from `src/utils/metrics.ts` (`errorRate = errors / max(calls, 1)`, `avgLatencyMs = latencyMsTotal / max(calls, 1)`), and the last probe from `eval/probe-latest.json` when present (read lazily, cached 60 s, absent means `unknown`). Status rules: `key_missing` when hidden for auth; `down` when the last probe was `ERROR` or `TIMEOUT` and live errorRate is at least 0.5 or calls are 0; `degraded` when errorRate is at least 0.2 or probe `EMPTY_REGRESSION`; else `ok`.
2. Register as tool 10 with `readOnlyHint: true`, `title`, `outputSchema`, `response_format`. Bump `TOOL_COUNT`, README, docs, tests.
3. Read cache: `withGuards.read` at `src/sources/registry.ts:242-310` currently caches nothing. Add a `readCache` keyed `source|id` on the existing `StateStore` cache API (key prefix `read|`), TTL by `freshness` (`static` 24 h, `daily` 10 min, `realtime` 0 = no cache), value capped at the existing read char limit. A hit skips pacing, quota, and the adapter call and increments `cacheHits`.
4. Tests: seeded counters (`resetMetricsForTests`) plus a fixture probe JSON produce the expected statuses; the read cache returns the stored result on the second call and never calls the adapter, and a `realtime` source is never cached.

**Tests:** new `libraryHealth.test.ts`, `readCache.test.ts`; registry tests extended. Gate green.

**Commit:** `feat(tools): library_health_check and a per-process read cache`.

---

### Task 3: Ingest policy field and source fixes (brief 06)

**Files:** `src/sources/registry.ts` (`SourceMeta`, `listSources`), new `src/sources/ingestPolicy.ts` and test, `src/tools/*` for `library_ingest` and `library_index`, `scripts/gen-docs.ts`, `src/sources/paperswithcode.ts`, `src/sources/hathitrust.ts` (removed), `src/sources/courtlistener.ts`, `src/sources/guardian.ts`, `src/sources/semanticscholar.ts`, `src/sources/stackexchange.ts`, `src/sources/wikisource.ts`, `src/sources/all.ts`, README, docs.

**Interfaces produced:** `SourceMeta.ingestPolicy?: 'allowed' | 'attribution' | 'timeboxed' | 'forbidden'` (default `allowed`); `assertIngestAllowed(meta)` in `src/sources/ingestPolicy.ts` throwing a clear error for `forbidden`, and for `timeboxed` unless `ALEXANDRIA_INGEST_TIMEBOXED=1`; `ingestMetadata(meta)` returning `{ license?, attribution?, expiresAt? }` to stamp on chunks.

1. Declare the field on `SourceMeta` (`registry.ts:46-70`), surface it in `listSources()` and `library_list_sources`, and in `docs/sources.md` via `buildSourcesDoc()` (`scripts/gen-docs.ts:53-97`) as a column.
2. Set explicit policies: `guardian` `timeboxed` (24 h per its terms), `semanticscholar` `attribution`, `stackexchange` `attribution`, `wikisource` `attribution`, `trove` `forbidden` (keep `supportsIngest: false`). Everything else stays default.
3. `library_ingest` calls `assertIngestAllowed` before chunking and stamps `ingestMetadata` on every chunk's metadata; `library_index` reports the policy in its preview.
4. Source fixes: `paperswithcode.ts` description states it queries the community mirror at paperswithcode.co (the original was retired 2025-07-24) and sets `verifiedAt` today; remove `hathitrust.ts` (its Data API was retired 2024-07-17 and the probe records EMPTY) from `all.ts` and the golden set if referenced; `courtlistener` `pacing.dailyCap` 125.
5. Config: add `ALEXANDRIA_INGEST_TIMEBOXED` to `src/config.ts` `rawFields` with a description; regenerate `.env.example`.
6. Tests: policy unit tests for all four values; an ingest test with a fake vector store asserting the refusal and the stamped metadata; `all.ts` count test updated.

**Tests:** new `ingestPolicy.test.ts`; ingest tests extended. Gate green; `npm run docs -- --check` green.

**Commit:** `feat(sources): ingest policy per source, honest paperswithcode, drop hathitrust, courtlistener cap`.

---

### Task 4: New sources, batch 1 (brief 06)

**Files:** new `src/sources/{wikipedia,wikidata,crossref,pubmed,medrxiv,secedgar,worldbank,datacite}.ts`, tests beside them, fixtures under `eval/fixtures/`, `src/sources/all.ts`, `eval/routing-golden.yaml` (one query per new source), README and docs (generated).

**Interfaces produced:** eight registered adapters with `defineRest` where the API is JSON.

1. Read each API's current docs before writing (context7 first, then the URLs in `research/source-coverage.md`). Rate and identity rules to honour in `headers` and `pacing`: Wikimedia needs a contact User-Agent; Crossref polite pool via `mailto` from `CONTACT_EMAIL` and 3 rps on list queries; PubMed E-utilities 3 rps keyless, `NCBI_API_KEY` optional for 10 rps; SEC requires a name and email User-Agent and 10 rps; DataCite 3,000 per 5 min.
2. Adapters: `wikipedia` (search via the REST `search/page`, read via the page summary plus `mobile-html` or `wikitext` through `fetchAsText`; cluster `web`, `attribution`), `wikidata` (entity search only, `supportsIngest: false`), `crossref` (search `works?query=`, read returns metadata plus `reference` list and a BibTeX string from content negotiation), `pubmed` (esearch then esummary; read via PMC BioC when a PMCID exists, else abstract via efetch), `medrxiv` (clone `biorxiv.ts` with `server=medrxiv`), `secedgar` (efts full-text search; read fetches the filing document through `fetchAsText`), `worldbank` (indicators search; read returns the indicator's recent series as text), `datacite` (DOI search across datasets).
3. Each adapter has a fixture-based test (search parse, read parse, error mapping) using `stubFetch`. Add one golden query per source to `eval/routing-golden.yaml` and re-run `npm run eval:routing` (BM25 mode is fine); record nDCG@5 before and after in the report.
4. `npm run docs`; README source table regenerates (146 sources).

**Tests:** eight new adapter tests. Gate green; docs check green.

**Commit:** `feat(sources): wikipedia, wikidata, crossref, pubmed, medrxiv, sec edgar, world bank, datacite`.

---

### Task 5: New sources, batch 2 (brief 06)

**Files:** new `src/sources/{hal,hansard,eurlex,bls,dblp,scielo,opencitations,readthedocs}.ts`, tests, fixtures, `all.ts`, golden set, docs.

1. Same discipline as Task 4. `hal` (Solr search with `text_fulltext`, PDF links into Task 6's tier), `hansard` (UK Parliament Hansard API, cluster `government`), `eurlex` (CELLAR SPARQL search, cluster `law`, results capped at 10,000 per the 2026 rule), `bls` (Public Data API v2, free key `BLS_API_KEY`, 500 per day), `dblp` (search API, 1 rps pacing), `scielo` (ArticleMeta search), `opencitations` (Index v2 citations and references by DOI; `supportsIngest: false`), `readthedocs` (server-side search API v3, `project:` prefix support, cluster `developer`).
2. Fixture tests, golden queries, eval before and after, docs regenerated (154 sources).

**Tests:** eight new adapter tests. Gate green.

**Commit:** `feat(sources): hal, hansard, eur-lex, bls, dblp, scielo, opencitations, read the docs`.

---

### Task 6: PDF tier with page anchors and an open-access fallback chain (brief 04)

**Files:** `src/web/fetchTier.ts`, new `src/web/pdf.ts` and test, new `src/web/openAccess.ts` and test, `src/types.ts` (`ReadResult`), `src/tools/libraryRead` handler in `src/index.ts`, `package.json` (`unpdf`).

**Interfaces produced:** `extractPdf(bytes: Uint8Array, url): Promise<{ title?, pages: { page: number, text: string }[], text: string }>`; `ReadResult.pages?: { page, charStart, charEnd }[]`; `ReadResult.unavailable?: { reason: 'no_full_text' | 'paywalled' | 'not_found' | 'too_large' | 'blocked', triedTiers: string[] }`; `resolveOpenAccess(doi): Promise<{ url, via: 'openalex' | 'pmc' | 'core' | 'fatcat' } | undefined>`.

1. Read `unpdf` docs via context7; confirm it runs on Node 24 without a worker and exposes per-page text. Add it as the one runtime dependency of this task.
2. `fetchTier.ts`: after the guarded fetch in the defuddle tier, branch on `content-type` containing `pdf` or a URL path ending `.pdf`: read the body under `MAX_RESPONSE_BYTES` and call `extractPdf`; return `{ url, title, text, via: 'pdf', pages }`. Non-HTML, non-PDF content types keep today's error.
3. `openAccess.ts`: given a DOI, try in order OpenAlex `works/doi:` `best_oa_location.pdf_url`, then PMC (`idconv` to PMCID, then the BioC full-text endpoint as text), then CORE (`CORE_API_KEY` only), then fatcat `release/lookup?doi=` archived PDF. Every hop goes through `assertFetchableUrl`. Return the first URL that resolves, with `via`.
4. `library_read`: when an adapter returns `metadataOnly` and the result carries a DOI (from `externalUrl` or an adapter-provided `doi` field added to `ReadResult`), call `resolveOpenAccess` then `fetchAsText`; on success return text with `pages` when it came from a PDF; on failure return `unavailable` with the tiers tried, never an empty string.
5. Tests: a small fixture PDF under `eval/fixtures/` (generate with a script, commit the bytes) for `extractPdf`; stubbed fetch for each OA hop including the all-fail case producing `unavailable`.

**Tests:** new `pdf.test.ts`, `openAccess.test.ts`; `index.test.ts` extended for the unavailable shape. Gate green.

**Commit:** `feat(read): PDF tier with page anchors and an open-access fallback chain`.

---

### Task 7: `library_citations` tool and bibliographic export (brief 04)

**Files:** new `src/tools/libraryCitations.ts` and test, new `src/utils/bibliography.ts` and test, `src/index.ts` (`TOOL_COUNT` 11), `src/index.test.ts`, README, docs.

**Interfaces produced:** `library_citations({ id, source, direction: 'references' | 'citations', limit, format?: 'bibtex' | 'ris' | 'apa', response_format })` returning `{ seed, direction, results: LibraryResult[], formatted?: string }`; `formatBibliography(items, style)` in `bibliography.ts`.

1. Resolve the seed to a DOI or OpenAlex id through the adapter's read metadata (arXiv ids map through OpenAlex `works/arxiv:`). Direction `references` reads OpenAlex `referenced_works` (batched `works?filter=openalex_id:` up to 50 per call); `citations` reads `cited_by_api_url`. OpenCitations (Task 5 adapter) is the fallback when OpenAlex has no record.
2. `formatBibliography`: BibTeX and RIS generated locally from `LibraryResult` fields; APA from the same fields; when a DOI exists and Crossref content negotiation succeeds, prefer its BibTeX.
3. Register as tool 11 (`readOnlyHint: true`), with `outputSchema` and `response_format`.
4. Tests: stubbed OpenAlex responses for both directions; batching over 51 ids makes two calls; formatting snapshots for the three styles.

**Tests:** new tool and formatter tests. Gate green; docs check green.

**Commit:** `feat(tools): library_citations with references, citers, and bibliography export`.

---

### Task 8: Answer and citation evaluation harness (brief 07)

**Files:** new `scripts/eval-answer.ts`, new `eval/answer-golden.yaml`, new `docs/answer-eval.md`, `package.json` scripts (`eval:answer`), `knip.json` entry.

**Interfaces produced:** `npm run eval:answer` printing citation precision, citation recall, URL and DOI resolvability rate, and answer nugget recall per query and overall, exiting 0 always unless `--gate` is passed.

1. `eval/answer-golden.yaml`: 20 questions across clusters, each with `expected_nuggets` (3 to 6 short factual statements) and `expected_sources` (source names). Write them by hand from the existing routing golden set's topics; every nugget must be checkable against a public source.
2. `scripts/eval-answer.ts`: runs `library_answer` per question (needs `synth` and `embeddings` roles; exits 0 with a message when absent, like `eval:routing`), then scores: citation precision = cited sentences whose cited chunk entails them (via the `verify` role from Task 9 when configured, else the `synth` role with the warrant-strength prompt), citation recall = nuggets covered by a cited sentence, resolvability = fraction of citation URLs and DOIs returning 2xx on a guarded HEAD or GET. Prints a table and a machine-readable last line like `eval-routing.ts`.
3. `docs/answer-eval.md` documents the metrics and records the first run's numbers as the baseline, in the same format as `docs/routing-eval.md`.

**Tests:** typecheck covers the script (scripts are in the typecheck set). A unit test for the scoring functions with fixture answers.

**Commit:** `test(eval): answer and citation harness with a 20-question golden set`.

---

### Task 9: Claim verification, citation liveness, and citation grades (brief 03, vault idea 6)

**Files:** `src/tools/libraryAnswer.ts`, `src/tools/libraryResearch.ts`, new `src/utils/claimCheck.ts`, `src/utils/liveness.ts`, `src/utils/citationGrade.ts` with tests, `src/utils/providers.ts` (role `verify`), `src/config.ts`, `src/sources/semanticscholar.ts` (`FIELDS`), `docs/answer-eval.md`.

**Interfaces produced:** role `verify` (falls back to the `synth` provider when unset); `checkClaims(answer, citations, chunks): Promise<{ sentence, citations: number[], supported: boolean, strengthWarranted: boolean, note? }[]>`; `checkLiveness(urls): Promise<Map<string, { ok: boolean, status?: number }>>` cached 24 h in the state store; `Citation.grade: { tier: 'A' | 'B' | 'C' | 'D', signals: { sourceTier, retracted?, citationCount?, influentialCitations?, year?, fullTextVerified, chainSupported? } }`; `Citation.resolves?: boolean`.

1. `claimCheck.ts`: split the answer into sentences; for each cited sentence build one `chatJSON('verify', ...)` call with the warrant-strength rubric from `research/retrieval-sota.md` section 4 (is the claim supported, and is its strength, scope, and time warranted by the cited text). Batch up to 8 sentences per call. Unsupported sentences have their citation markers removed and a `warnings[]` entry added; over-strength sentences keep the citation and add a warning.
2. `liveness.ts`: guarded `HEAD` falling back to `GET` with a 5 s timeout through the source dispatcher; results cached in the state store under `live|<url>`; never fetch more than 20 URLs per answer. Set `citations[].resolves`.
3. `citationGrade.ts`: `sourceTier` from a static map by cluster and source (peer-reviewed OA journals and indexes 1; preprint servers 2; libraries, archives, government 2; RSS, news, web fetch 4), enriched when a DOI exists by one batched OpenAlex `works?filter=doi:` call (`is_retracted`, `cited_by_count`, `primary_location.source.type`); add `citationCount,influentialCitationCount,isOpenAccess` to the Semantic Scholar `FIELDS`. Retracted means tier D and a warning. `fullTextVerified` comes from `readTopSources`; `chainSupported` from `checkCitations` in research when it ran.
4. Wire into `libraryAnswer` after `readTopSources` (`libraryAnswer.ts:269`) and into `libraryResearch` for the final report. Grades and `resolves` appear in `detailed` output only; warnings appear in both.
5. Config: `ALEXANDRIA_VERIFY_*` role vars, `ALEXANDRIA_CLAIM_CHECK=off` to disable; `.env.example` regenerated.
6. Measure: run `npm run eval:answer` before and after with the roles configured against the Cave gateway; record citation precision and resolvability in `docs/answer-eval.md`.

**Tests:** unit tests for sentence splitting and marker removal, liveness caching, the grader's tier rules with fixture OpenAlex responses; answer tests extended with a stubbed verify role.

**Commit:** `feat(answer): claim verification, citation liveness, and citation grades`.

---

### Task 10: Cross-encoder rerank backends and margin-gated multi-query (brief 07)

**Files:** new `src/utils/rerank.ts` and test, `src/utils/fuse.ts` (`llmRerank` moves behind the new interface), `src/tools/libraryAnswer.ts`, `src/tools/libraryAsk.ts`, `src/config.ts`, `docs/routing-eval.md`, `docs/answer-eval.md`.

**Interfaces produced:** `rerank(query, candidates, { backend })` with backends `llm` (existing listwise, now over at most 20 shuffled candidates), `cohere` (POST `/rerank` in the Cohere request shape, which Jina, Voyage, Cohere, and LiteLLM all accept; base URL and key from the `rerank` role), and `workers-ai` (Cloudflare `@cf/baai/bge-reranker-base` `{ query, contexts }` shape); `ALEXANDRIA_RERANK` accepts `off | llm | cohere | workers-ai`.

1. Read the Cohere rerank request and response shape and the Workers AI reranker shape (context7, then `research/cloudflare-platform.md` section 3).
2. `rerank.ts` implements the three backends behind one function; `library_answer` reranks the RRF top 50 to 100 (config `ALEXANDRIA_RERANK_POOL`, default 60) and only then applies the LLM listwise pass when `llm` is selected, over the top 20 with input order shuffled.
3. Multi-query: in `libraryAsk`, when stage 1 ran and its margin is below the skip margin, ask the `router` role for two alternate phrasings, run stage 1 for each, and union the candidate lists before stage 2 (`ALEXANDRIA_MULTI_QUERY=1`, default off until measured).
4. Measure both with the harnesses: `eval:routing` with and without multi-query (embeddings via the Cave gateway); `eval:answer` with `ALEXANDRIA_RERANK=cohere` pointed at any configured `/rerank` endpoint (record "not measured" plainly if none is reachable). Record in the two eval docs.

**Tests:** stubbed endpoints for the two HTTP backends; the LLM backend's shuffle is deterministic under a seeded test; multi-query union dedups by source.

**Commit:** `feat(retrieval): cross-encoder rerank backends and margin-gated multi-query`.

---

### Task 11: Research stopping, chunk prefixes, OCR gate (brief 07)

**Files:** `src/tools/libraryResearch.ts`, `src/pipeline/index.ts`, `src/utils/text-clean.ts`, tests beside them, `docs/answer-eval.md`.

1. Stopping: before round 1, ask the `research` role for an outline of 3 to 7 coverage objectives for the topic. After each round, mark objectives covered by any learning (one `chatJSON` call). Stop when every objective is covered, or when `depth`, `breadth`, or `max_minutes` runs out as today. Report `objectives` and `coverage` in the result's detailed output.
2. Chunk prefix: `chunkSemantic` prepends `title` and the nearest heading chain (markdown `#` headings when present) to each chunk's embedded text, keeping the raw chunk text for display. Config `ALEXANDRIA_CHUNK_PREFIX=off` to disable.
3. OCR gate: `ocrQualityScore` adds a lexicon-hit ratio (a bundled 5,000-word English list plus per-chunk digit and punctuation ratios) and returns the minimum of the regex score and the lexicon score. Threshold unchanged.
4. Tests: a fixture topic where objectives are covered after one round stops early; chunk prefix appears in the embedded text and not in the display text; a garbage-OCR fixture scores below threshold and a clean one above.

**Commit:** `feat(research): objective-driven stopping, chunk prefixes, lexicon OCR gate`.

---

### Task 12: Corpus as cache (vault idea 5)

**Files:** `src/types.ts` (`VectorStoreProvider.query`), `src/pipeline/providers/supabase.ts`, new `docs/sql/match_chunks.sql`, new `src/pipeline/corpusSearch.ts` and test, `src/tools/libraryAnswer.ts`, `src/config.ts`, README ingest section.

**Interfaces produced:** `VectorStoreProvider.query(embedding: number[], k: number, filter?: { sources?: string[] }): Promise<{ id, source, sourceId, chunkIndex, text, similarity, metadata }[]>`; `corpusSearch(query): Promise<LibraryResult[]>` returning `source: 'corpus'`, `hasFullText: true`, `id: <source>:<sourceId>:<chunkIndex>`.

1. `docs/sql/match_chunks.sql`: a `match_knowledge_chunks(query_embedding, match_count, min_similarity, sources text[])` function over the existing table, plus an HNSW index statement replacing ivfflat. Document the migration in the README.
2. `corpusSearch.ts`: embed the query with the `embeddings` role, call `query`, filter to `similarity >= ALEXANDRIA_CORPUS_MIN_SIM` (default 0.92) and to sources whose `freshness` is `static` or `daily`. Never used for `realtime` clusters.
3. `libraryAnswer`: fold corpus hits in as one more RRF list next to `fetchKnowledgeResults`; `readTopSources` short-circuits for corpus items (text already in hand, no adapter read).
4. Tests: a fake provider returning canned chunks; corpus hits appear in results; no `read()` is invoked for them; a realtime-only query never calls `corpusSearch`.

**Commit:** `feat(pipeline): corpus-as-cache read-through for library_answer`.

---

### Task 13: Runtime: extraction off the event loop, markdown hop, honest UA, HTTP guards (brief 08)

**Files:** `src/web/fetchTier.ts`, new `src/web/extract.ts`, `src/web/extractWorker.ts`, tests, new `src/httpGuards.ts` and test, `src/index.ts` (listener), `src/config.ts`, `docs/` prose.

1. Extraction: move the linkedom plus Defuddle call into `src/web/extractWorker.ts` run under `node:worker_threads` (one worker, lazily started, restarted on crash, 30 s per-job timeout); `src/web/extract.ts` exposes `extractHtml(html, url)` returning the same `{ title, text }` and falls back to in-thread extraction when workers are unavailable. Measure with the two pages from the Rust spike (`/tmp/claude-1001/.../scratchpad/pg1342.htm`, `wiki.htm`; regenerate by download if absent): the event loop stays responsive during a 3 s extraction (a concurrent `/health` answers under 50 ms).
2. Markdown for Agents: the defuddle tier sends `Accept: text/markdown, text/html;q=0.9`; when the response `content-type` is `text/markdown`, use the body directly as `text` (`via: 'markdown'`) and skip extraction.
3. User-Agent: `BROWSER_UA` at `fetchTier.ts:62` becomes `Alexandria/<version> (+https://github.com/The-40-Thieves/alexandria-mcp)` by default, overridable with `ALEXANDRIA_FETCH_UA`. Run `npm run probe` before and after; list every source whose status changed, and for each regression either keep the old UA for that adapter through its `headers` or record the loss.
4. HTTP guards: apply the `@modelcontextprotocol/node` host-header and origin validation guards on `/mcp` (allowlist from `ALEXANDRIA_ALLOWED_ORIGINS`, loopback always allowed), and a per-client-IP token bucket on `/mcp` (`ALEXANDRIA_HTTP_RATE_LIMIT`, default 60 per minute, 429 with a JSON-RPC error body).
5. Tests: worker extraction returns the same text as in-thread for a fixture; markdown response bypasses extraction; origin rejection returns 403; rate limit returns 429 on the 61st request.

**Commit:** `perf(web): extraction off the event loop, markdown hop, honest UA, HTTP guards`.

---

### Task 14: Protocol: 2026-07-28 dual-era handler, prompts, document resources (brief 05)

**Files:** `src/index.ts`, new `src/prompts.ts`, `src/resources.ts` with tests, `src/index.test.ts`, README.

1. Read `research/mcp-ecosystem.md` section 1 and the SDK's `support-2026-07-28.md` (fetch via context7 or the GitHub URL in the report). Replace the per-request transport construction with `createMcpHandler(factory)` from `@modelcontextprotocol/server` adapted by `toNodeHandler()` from `@modelcontextprotocol/node`, `legacy: 'stateless'`, so one endpoint serves both eras. stdio uses `serveStdio(factory)`. Keep the body cap, malformed-target safety, and the listener-level catch from PR #23.
2. Prompts: `literature_review(topic, depth?)`, `fact_check_claim(claim)`, `verify_bibliography(references)` registered with `registerPrompt`; each returns a user message that names the tools to call in order.
3. Resources: `library://doc/{source}/{id}` template via `registerResource` returning the read text; search results in `detailed` mode carry a `resource_link` content item for each result with full text.
4. Tests: a 2026-07-28 `server/discover` probe and a legacy `initialize` both succeed against the listener; `prompts/list` returns three; `resources/read` on the template returns text from a stubbed adapter.

**Commit:** `feat(mcp): 2026-07-28 dual-era handler, prompts, document resources`.

---

### Task 15: Cloudflare integration guide and Browser Run render tier (brief 08, Cloudflare deep dive)

**Files:** new `docs/cloudflare.md`, new `src/web/browserRun.ts` and test, `src/web/fetchTier.ts`, `src/config.ts`, README (link only).

1. `docs/cloudflare.md` from `research/cloudflare-platform.md`: the hybrid verdict and why (node:sqlite stub, undici dispatchers not honoured, 6-connection header-wait cap); env-only recipes for AI Gateway BYOK on the LLM roles (new unified `api.cloudflare.com/.../ai/v1` endpoint and the legacy `gateway.ai.cloudflare.com` path), Workers AI `bge-m3` for `embeddings`, `bge-reranker-base` for `rerank` (`ALEXANDRIA_RERANK=workers-ai` from Task 10); Tunnel plus Access service tokens for a private `/mcp`, WAF rate-limiting for a public one; R2 via S3 as an optional store for cached texts (documented, not implemented); what a full Workers port would cost.
2. `browserRun.ts`: a fourth fetch tier using Browser Run's REST `/markdown` endpoint (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_BROWSER_RUN_TOKEN`), after crawl4ai, only when configured; the target URL still passes `assertFetchableUrl` first; response capped at `MAX_RESPONSE_BYTES`.
3. Tests: stubbed endpoint returns markdown; unconfigured tier is skipped; a private-range URL is rejected before any call.

**Commit:** `feat(web): Cloudflare Browser Run render tier; docs: Cloudflare integration guide`.

---

### Task 16: Release readiness (brief 02), stopping before the tag

**Files:** `package.json`, `package-lock.json`, `.github/workflows/package-v.yml`, new `server.json`, new `docs/distribution/docker-server.yaml`, `CHANGELOG.md`, `README.md` install section, `.gitignore`.

1. `package.json`: `publishConfig.registry` to `https://registry.npmjs.org`, `publishConfig.access: public`, `mcpName: "io.github.the-40-thieves/alexandria-mcp"`, `bin` entry so `npx @the-40-thieves/alexandria-mcp` starts stdio, version `11.0.0` (new tools, `response_format` default, ingest refusals, and the removed source are breaking for consumers).
2. `package-v.yml`: on tag `v*`, `permissions: id-token: write`, `npm publish --provenance --access public` with npm trusted publishing (no token secret); keep the build-first step. Read npm's current trusted-publisher docs via context7 before editing. The npmjs-side trusted publisher registration is an owner action; document it in the PR body.
3. `server.json` per the registry schema in `research/mcp-ecosystem.md` section 2: npm package with `runtimeHint: npx`, `environmentVariables` for the optional keys, and a `remotes` streamable-http entry with a placeholder-free URL only if hosting is decided (otherwise omit `remotes`).
4. `docs/distribution/docker-server.yaml`: the `docker/mcp-registry` submission file (local type, MIT) ready to PR.
5. `CHANGELOG.md` 11.0.0 entry listing every task's user-visible change; README install section shows `npx` and `claude mcp add`; `.gitignore` gains `eval/probe-latest.json`.
6. Trigger the weekly probe by hand (`gh workflow run "Weekly probe"`), confirm it completes and files no regression issue (or that the filed issue is correct).
7. Do not tag. The report ends with the exact commands for the tag, the npm publish (via the workflow), `mcp-publisher publish`, and the Docker PR, for the controller to run after confirmation.

**Tests:** gate green; `npm pack --dry-run` lists no tests; `npx -y ./$(npm pack | tail -1)` starts and answers `tools/list` over stdio.

**Commit:** `build(release): npmjs publishing with provenance, registry manifest, 11.0.0 changelog`.

---

## Self-review

- Spec coverage: brief 02 (Task 16 plus instructions in Task 1), 03 (Task 9, harness in Task 8), 04 (Tasks 6, 7), 05 (Tasks 1, 14), 06 (Tasks 3, 4, 5), 07 (Tasks 8, 10, 11), 08 (Tasks 13, 15); vault ideas 1, 5, 6, 7 (as read cache), 10 (Tasks 2, 12, 9, 2, 1). Deferred with reasons recorded in the ledger: geographic routing, Rust or wasm extraction (worker thread first), Claude Citations API path (provider layer is OpenAI-compatible), cold-start bundling, OAuth resource-server mode (hosting undecided), Tasks extension (not in SDK v2).
- Type consistency: `response_format` enum and `formatResult` (Task 1) are consumed by Tasks 2, 7; `Citation.grade` and `resolves` (Task 9) are surfaced by Task 1's detailed shape; `ReadResult.unavailable` and `pages` (Task 6) are read by Task 14 resources; `rerank()` backends (Task 10) are documented by Task 15.
