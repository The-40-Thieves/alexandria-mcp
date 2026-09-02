# Alexandria stack efficiency program (2026-09-02)

**Goal:** Land the eleven recommendations of the 2026-09-02 stack review as eight reviewed, gated, squash-merged PRs on `The-40-Thieves/alexandria-mcp` main, each with a measured before/after where the review promised one.

**Spec:** the stack review, vault note `02-projects/alexandria-2026-09-02-stack-review-and-efficiency-plan` (published copy: https://claude.ai/code/artifact/7c808876-fe0b-4208-88eb-9490fac5d047). Section numbers below (3.1 to 3.11) are the review's. Baseline at main 401e544: typecheck 17.1 s (TS 5.9.3), build 12.0 s, test suite 44 s under tsx, cold start 0.69 s, 705 tests, 588 `.js`-suffixed relative imports across 249 files, 71 `process.env` reads, 8 `console.*` sites, knip 154 unused exports.

## Global Constraints

- Gate before every commit that ends a task: `npm run gate` (typecheck, build, test, biome) and `npm run docs -- --check`, both exit 0. Quote the test count in the report. Capture exit codes; never pipe a gate into grep to decide pass/fail.
- Every commit is DCO-signed (`git commit -s`). Conventional-commit subjects (`fix(scope):`, `build:`, `feat(scope):`, `refactor:`, `test:`, `docs:`).
- No em dashes anywhere: code, comments, docs, commit messages. Use a comma, a colon, or a full stop.
- Never log or return credential values. Error strings may include URLs.
- The SSRF guard in `src/web/fetchTier.ts` (`assertFetchableUrl`, redirect re-validation, origin allowlist) keeps its behaviour exactly. Any change that routes guarded fetches through a new dispatcher must prove, with a test, that the guard's resolved address is the one connected to.
- Runtime dependencies may be added only where a task names them: `undici` (Task 3), `pino` (Task 5), the `@modelcontextprotocol/*` v2 packages (Task 7). Dev dependencies: `knip` (Task 1). Nothing else.
- Test runner stays `node:test`. New tests mock the network; no unit test may reach a live endpoint.
- Before writing code against a library or runtime API, fetch its current docs with `npx ctx7@latest library "<name>" "<question>"` then `npx ctx7@latest docs <id> "<question>"`. Applies to TypeScript 7 options, Node's TypeScript module loading, `node:sqlite`, undici interceptors, pino, and the MCP SDK v2.
- Measure what the review promised: each task's report carries the before and after numbers it names, with the command run and its output.
- Branch per task, `eff/task-<N>`, from current main. The controller opens the PR, reviews, and squash-merges before the next task starts; each task starts from the merged main.
- Docs that count things (README source counts, `/health` example, `docs/sources.md`) are generated; run `npm run docs` rather than editing them by hand.

## File Structure

New files by task (existing files are named inside each task):
- Task 1: `knip.json`
- Task 2: `src/sources/__tests__/read-paths.test.ts` (fetch-tier read tests for five sources)
- Task 3: `src/utils/dispatcher.ts`, `src/utils/dispatcher.test.ts`
- Task 4: `src/utils/stateStore.ts`, `src/utils/stateStore.test.ts`
- Task 5: `src/config.ts`, `src/config.test.ts`, `src/log.ts`, `src/log.test.ts`, `src/utils/metrics.ts`, `src/utils/metrics.test.ts`
- Task 6: `docs/routing-eval.md` (updated), tests in `src/utils/catalogIndex.test.ts` and `src/tools/libraryAsk.test.ts`
- Task 7: none new; `package.json` dependency set changes
- Task 8: `src/utils/xml.ts`, `src/utils/xml.test.ts`

---

### Task 1: Toolchain: TypeScript 7, Node 24, dead-weight removal, knip in the gate (review 3.1, 3.10)

**Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `mise.toml`, `.github/workflows/ci.yml`, `.github/workflows/package-v.yml`, `.github/workflows/probe.yml`, `README.md` (any "Node 22" prose only), new `knip.json`.

1. Record the before numbers: `/usr/bin/time -f '%e' npx tsc --noEmit` (three runs, report the median) and `npm run build` wall time.
2. `typescript` to `^7.0.2`. Add `"types": ["node"]` to `compilerOptions` in `tsconfig.json` (the build config extends it). Fix any option TS 7 rejects; do not add options the tree does not need.
3. Node 24: `mise.toml` `node = "24"`; `engines.node` `">=24.0.0"`; all three workflows `node-version: 24`; `@types/node` to `^24`. Do not change any import to `.ts` in this task (that is Task 2).
4. Remove `@google/genai` from `optionalDependencies`. Confirm with `rg -n "@google/genai" src scripts` that nothing imports it. Regenerate the lockfile with `npm install`; `npm ci` must succeed from scratch.
5. Minor bumps: `openai` and `@supabase/supabase-js` to their current minor (`npm update` for those two only).
6. knip: add `knip` as a dev dependency, a `knip.json` with `"ignoreExportsUsedInFile": true` and entry points `src/index.ts`, `scripts/*.ts`, `src/sources/all.ts`. Run `npx knip`; resolve what remains (unused files, unused dependencies, unlisted dependencies) by deleting or declaring, never by ignoring a real finding. Add `"knip": "knip"` to scripts and put it in `gate` after `lint`, and in `ci.yml` after `biome ci`.
7. Record the after numbers the same way as step 1. Report both.

**Tests:** the existing suite (no new tests). Gate green. `npm pack --dry-run --json | jq '.[0].files|length'` unchanged from 598 or explained.

**Commit:** `build: TypeScript 7, Node 24, knip in the gate, drop the unused genai dep`.

---

### Task 2: Native TypeScript execution and test hygiene (review 3.2, 3.9)

**Files:** every `.ts` under `src/` and `scripts/` with a relative `.js` import (588 sites in 249 files), `tsconfig.json`, `tsconfig.build.json`, `package.json`, tests that reach the network, new `src/sources/__tests__/read-paths.test.ts`, `src/utils/mcpTestServer.ts` if its imports change.

1. Record before: `time npm test` (wall), three runs, median.
2. Read Node's current documentation on running TypeScript natively (module detection, `.ts` in a package with and without `"type": "module"`, `import.meta.dirname`) and TypeScript's `rewriteRelativeImportExtensions`, `allowImportingTsExtensions`, `erasableSyntaxOnly`. Decide, and write in the report, how `src/version.ts` and any other `__dirname` or `require` use will resolve under native execution. If the package must become `"type": "module"` for native execution to work, do it, and fix the fallout (`__dirname` becomes `import.meta.dirname`).
3. Rewrite every relative import specifier ending in `.js` to `.ts`: static `import`/`export ... from`, dynamic `import()`, and `import type`. Do it with one deterministic script (a node script or `sd`/`sed` with a reviewed regex), commit that script's command in the commit message, and never edit the 249 files by hand. Non-relative and package imports are untouched.
4. tsconfig: `allowImportingTsExtensions: true`, `rewriteRelativeImportExtensions: true`, `erasableSyntaxOnly: true`. `dist/` must still contain `.js` files importing `.js` (check one file). `npm run build` and `node dist/index.js` still start (`/health` reachable under `TRANSPORT=http`).
5. Scripts: `test` becomes `node --test --test-reporter=spec --test-concurrency=<n> 'src/**/*.test.ts' 'scripts/**/*.test.ts'` where n is `os.availableParallelism()` at the time of writing (Cave has 4; set 4). `dev` becomes `node src/index.ts`; `probe`, `probe:baseline`, `eval:routing`, `docs` run `node scripts/<file>.ts`. Remove `tsx` from devDependencies. `npm run docs -- --check` still passes.
6. Test hygiene: find every test that reaches a live endpoint (start with `src/web/fetchTier.test.ts` and the jina and defuddle paths; `rg -n "https?://" src --glob '*.test.ts'` and read each hit) and mock the network so `npm test` passes with networking disabled (verify with `unshare -rn npm test` or an equivalent; if the sandbox forbids it, set a bogus `HTTPS_PROXY` and show the suite still passes). Live-endpoint checks belong to `scripts/probe.ts`.
7. Add `src/sources/__tests__/read-paths.test.ts`: for federalregister, gdelt, mdn, nhk, and peps, a test per source that mocks the fetch tier (or `globalThis.fetch`) and asserts `read()` returns text via the tier and falls back to metadata when the tier fails. Use the same mocking style the existing `src/sources/__tests__/*.test.ts` files use.
8. Record after: `time npm test`, three runs, median. Report before and after.

**Tests:** the whole suite natively, plus the five new read tests. Gate green.

**Commit(s):** `build: run TypeScript natively, drop tsx` (the import rewrite may be its own commit: `refactor: import .ts specifiers for native execution`), `test: mock the network in unit tests, cover the five fetch-tier read paths`.

---

### Task 3: One tuned undici dispatcher under every source (review 3.3)

**Files:** new `src/utils/dispatcher.ts` and test, `src/index.ts` (install at startup), `scripts/probe.ts` and `scripts/eval-routing.ts` (install at startup), `src/utils/http.ts`, `src/web/fetchTier.ts`, `package.json` (`undici`), `README.md` env docs via `npm run docs` if the generator covers ops vars, otherwise the hand-written env section.

1. Read the current undici docs for `Agent`, `setGlobalDispatcher`, `interceptors.dns`, `interceptors.cache`, `cacheStores.SqliteCacheStore` and `MemoryCacheStore`, and the `dispatcher` option on `fetch`. Confirm on Node 24 that a dispatcher from the `undici` package set via `setGlobalDispatcher` is honoured by the global `fetch` (write a two-line check and put the output in the report).
2. `src/utils/dispatcher.ts`: `installDispatcher(opts)` builds `new Agent({ connections, keepAliveTimeout, headersTimeout, bodyTimeout })` composed with `interceptors.dns({ maxTTL })` and `interceptors.cache({ store })`, and sets it global. The store is `SqliteCacheStore` at `ALEXANDRIA_HTTP_CACHE` (default `data/http-cache.db`, directory created if missing); if the location is unwritable, fall back to `MemoryCacheStore` and log once. Export `sourceDispatcher` (the composed agent) and `guardedDispatcher` (a plain `Agent` with the same limits but no dns interceptor) for Task 3 step 4. Values: connections 64, keepAliveTimeout 30 s, headersTimeout 15 s, bodyTimeout 15 s, dns maxTTL 60 s, cache maxSize 256 MB, maxEntrySize 5 MB.
3. Install it once at startup in `src/index.ts` before the transport starts, and in the two scripts. Idempotent (a second call is a no-op).
4. SSRF interplay: `src/web/fetchTier.ts` resolves and validates the address before fetching. Every fetch it issues after validation must pass `dispatcher: guardedDispatcher` so the dns cache can never answer a guarded URL, and must connect to the address the guard validated. Read the existing comment in `fetchTier.ts` about the connection being made a moment later, and close that gap now: use the `Agent` `connect.lookup` hook (or undici's documented equivalent) so the guarded dispatcher connects to the validated address. A test must prove it: a hostname whose first resolution is public and whose second is private must be refused or connected to the first address, never the second.
5. Do not add `interceptors.retry`; `fetchWithRetry` already owns retry and Retry-After parsing.
6. Tests (`src/utils/dispatcher.test.ts`): a local `http` server that sets `Cache-Control: max-age=60` is hit once for two identical GETs through the composed dispatcher, and the second response carries the interceptor's cache marker; a `no-store` response is fetched twice; the memory fallback engages when the sqlite path is a file inside a non-existent directory that cannot be created (point it at `/proc/...` or a read-only location).
7. Measure: with the dispatcher installed, run `npm run probe` twice back to back (cold, then warm) and report wall time and the probe's own OK/ERR counts for both. Report the same two runs on main before the change (check out main in a scratch worktree, or record the numbers from the first run before your change).

**Tests:** new dispatcher tests plus the SSRF pin test in `src/web/fetchTier.test.ts`. Gate green.

**Commit:** `perf(http): one tuned undici dispatcher with dns and RFC 9111 cache under every source`.

---

### Task 4: Persist the guard state with node:sqlite (review 3.4)

**Files:** new `src/utils/stateStore.ts` and test, `src/utils/quotaLedger.ts`, `src/utils/resultCache.ts`, `src/sources/registry.ts` (health summary), `src/index.ts` (`/health`), tests for ledger and cache.

1. Read the current Node docs for `node:sqlite` (`DatabaseSync`, `prepare`, `run`, `get`, `all`, transactions, WAL pragma) before writing.
2. `src/utils/stateStore.ts`: a small interface `StateStore` with `getQuota(source, day)`, `reserveQuota(source, day, cap)` (atomic: returns false when the cap is reached), `getCache(key)`, `setCache(key, value, expiresAt)`, `evictExpired()`, `close()`. Two implementations: `MemoryStateStore` (current behaviour, used by tests) and `SqliteStateStore` on `node:sqlite` at `ALEXANDRIA_STATE_DB` (default `data/alexandria.db`, WAL mode, directory created). Selection in one place at startup; default sqlite, memory when the env var is `:memory:` or the path is unwritable (log once).
3. `quotaLedger.ts` and `resultCache.ts` use the store. The result cache keeps its LRU cap (500 entries) and TTL; in sqlite the cap is enforced by count on insert. Pacing stays in memory.
4. `/health` gains `quota: { day, reserved: <total>, sources: <count with any usage> }` and `cache: { entries }` from the store. Update the README health example via `npm run docs` if generated, else by hand.
5. Tests: reserve up to a cap and one over, in memory and in sqlite (temp file); close and reopen the sqlite store and read the same count back; cache TTL expiry; the 500-entry cap. The existing registry tests keep passing with the memory store.
6. Measure: start the server with `TRANSPORT=http`, make a `library_search` call twice, restart the process, call `/health`, and show the reserved count survived. Put the transcript in the report.

**Tests:** new store tests, updated ledger and cache tests. Gate green.

**Commit:** `feat(state): quota ledger and result cache on node:sqlite, survive restarts`.

---

### Task 5: Config module, structured logs, per-source metrics (review 3.6, 3.7)

**Files:** new `src/config.ts`, `src/log.ts`, `src/utils/metrics.ts` and their tests; every non-adapter module that reads `process.env` (`src/index.ts`, `src/utils/providers.ts`, `src/utils/resultCache.ts`, `src/utils/catalogIndex.ts`, `src/utils/mcpClientPool.ts`, `src/web/fetchTier.ts`, `src/tools/libraryAnswer.ts`, `src/tools/libraryResearch.ts`, `src/utils/dispatcher.ts`, `src/utils/stateStore.ts`, others found by `rg -n 'process\.env' src --glob '!src/sources/**'`); `scripts/gen-docs.ts`; `src/sources/registry.ts` (counters); `package.json` (`pino`).

1. `src/config.ts`: one zod schema for the ops-level environment (transport, port, `ALEXANDRIA_*` base URLs, keys, models per role, cache TTL, catalog cache path, http cache path, state db path, fetch tier URLs and keys, `DEBUG`, `KNOWLEDGE_MCP_*`). `loadConfig(env = process.env)` parses once and returns a frozen typed object; a parse failure throws one error listing every bad variable by name (never its value). A module-level `config` getter is lazy so tests can set env first. Every listed module reads from `config`, not `process.env`. Adapter files keep their `auth` and `optionalEnv` declarations; the registry keeps reading those. After the change, `rg -c 'process\.env' src --glob '!src/sources/**' --glob '!src/config.ts'` is zero or each remaining site is justified in the report.
2. `scripts/gen-docs.ts` emits the ops section of `.env.example` from the config schema (name, default, description from a `.describe()` on each field) and the source keys from the registry as it does today.
3. `src/log.ts`: pino, JSON to stderr (stdout is the stdio transport), level from config, redaction of any field named like a key or token, and a child logger per MCP request carrying a `reqId` and the tool name, stored on the existing `AsyncLocalStorage` request context in `src/utils/http.ts`. Replace the eight `console.*` sites. The startup banner stays one line.
4. `src/utils/metrics.ts`: per-source counters (calls, errors, timeouts, cacheHits, quotaRejections, latencyMsTotal) incremented inside the registry wrapper, plus per-tool counters (invocations, llmCalls). Exposed as `/metrics` (JSON) on the HTTP transport and summarised on `/health` (`sources.calls`, `sources.errors`). The `llmCalls` counter is incremented in `providers.ts` per chat and embed call; Task 6 reads it.
5. Tests: config parses a good env and rejects a bad one naming the variable; log redaction; a counter increments through a wrapped adapter call and appears on `/metrics`.

**Tests:** new tests plus updated ones where `process.env` was set in tests. Gate green.

**Commit(s):** `refactor(config): one validated config module for the ops environment`, `feat(observability): pino logs with request ids, per-source and per-tool counters`.

---

### Task 6: Fewer LLM calls per tool call (review 3.5)

**Files:** `src/utils/catalogIndex.ts`, `src/tools/libraryAsk.ts`, `src/utils/resultCache.ts` or a routing cache beside it, `scripts/eval-routing.ts`, `docs/routing-eval.md`, `src/config.ts` (two settings), tests.

1. Stage-1 margin: `catalogIndex` returns, with the shortlist, a `margin` (score of the top candidate minus the score at position `maxSources + 1`, normalised by the top score) and the top cluster. Log it at debug on every `library_ask`.
2. Router skip: when `margin >= config.routerSkipMargin` (setting `ALEXANDRIA_ROUTER_SKIP_MARGIN`, default chosen in step 5), `libraryAsk` skips the LLM router call and fans out to the stage-1 top `maxSources` with the raw query. The routing result records `stage2: 'skipped'` so callers and the eval can see it.
3. Routing cache: cache the routing decision by normalised query and `maxSources` for the result cache TTL, through the Task 4 store. A cache hit costs no LLM call.
4. Embeddings through the Cave gateway for the eval only: `ALEXANDRIA_EMBED_BASE_URL=http://100.78.123.100:4001/v1`, `ALEXANDRIA_EMBED_API_KEY` from `LITELLM_AGENT_KEY` in `/data/llm-stack/.env` (source it into the shell; never write the value into any file or log), `ALEXANDRIA_EMBED_MODEL=BAAI/bge-m3`. Do not commit any key.
5. Run `npm run eval:routing` four ways and record all four in `docs/routing-eval.md` with the date: BM25-only with the LLM router; BM25-only with skip at the candidate margins 0.2, 0.3, 0.4; embeddings with the LLM router; embeddings with skip at the same margins. Choose the default `routerSkipMargin` as the largest margin whose nDCG@5 is within 0.01 of the LLM-router number on the better of the two stage-1 modes, and write that reasoning in the doc. Also report the LLM-call count per `library_ask` (from the Task 5 counter) for each configuration.
6. Tests: margin computation on a fixed catalog; skip path taken above the threshold and not below; routing cache hit skips the router (count calls on a stubbed `chatJSON`).

**Tests:** new tests. Gate green; `npm run eval:routing` exits 0 in the embedding configuration.

**Commit:** `perf(routing): skip the LLM router on a confident stage 1, cache routing decisions, embeddings measured`.

---

### Task 7: MCP SDK v2 (review 3.8)

**Files:** `package.json`, `package-lock.json`, `src/index.ts`, `src/utils/mcpClientPool.ts`, `src/utils/mcpTestServer.ts`, `src/sources/kinds/mcp.ts`, any file importing `@modelcontextprotocol/sdk`, `README.md` (transport section), `tsconfig.json` if v2 needs an option.

1. Read the v2 migration guide and the `@modelcontextprotocol/node` and `/express` READMEs first. Run `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` at the package root and read every change it made.
2. Manual part: transports (`NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`, `StdioServerTransport` from `@modelcontextprotocol/server`), client imports in the pool from `@modelcontextprotocol/client`, schema constants from `@modelcontextprotocol/core`. Keep the per-request server-and-transport pattern in `handleMcpRequest` and its concurrency test.
3. Express decision: replace Express with the `@modelcontextprotocol/node` adapter plus a plain `node:http` handler for `/health` and `/metrics` if that removes `express` from dependencies without losing behaviour (JSON body limits, error handler shape, the 404 for other paths). If any behaviour would be lost, keep Express and say why in the report.
4. Protocol version: do not opt into speaking 2026-07-28 on the wire; leave the SDK default and record in the README how to opt in.
5. `npm ls @modelcontextprotocol/sdk` prints nothing; `npm pack --dry-run` file count reported; the HTTP concurrency test and the pool tests pass.

**Tests:** existing MCP tests updated; gate green.

**Commit:** `build(mcp): SDK v2 packages, Node transport adapter` (plus `build: drop express` if step 3 removes it).

---

### Task 8: Shared XML parsing (review 3.11)

**Files:** new `src/utils/xml.ts` and test; the adapters that parse XML by regex or `node-html-parser` (find them: `rg -ln 'parse\(|<[a-zA-Z]+>' src/sources --glob '!*.test.ts' | xargs rg -l 'xml|<entry|<record|<item' -i`, then read each; expect about fifteen: arxiv, europeana, bhl, gallica, europmc, nasaads and others); their tests and fixtures.

1. `parseXml<T = unknown>(text, opts?)` on `fast-xml-parser` with: `ignoreAttributes: false`, `attributeNamePrefix: '@_'`, `isArray` accepting a list of tag names that are always arrays, `textNodeName: '#text'`, entity processing on, and a helper `asArray(x)`. Typed as loosely as the callers need; no schema validation.
2. Migrate each XML adapter to `parseXml`, keeping its normalised output byte-identical on the adapter's existing fixture tests. Where an adapter has no fixture test, add one from a saved real response (redact nothing but keep it under 20 KB) before migrating, so the migration is checked against it.
3. Remove now-unused regex helpers. `node-html-parser` stays for the adapters that parse HTML.

**Tests:** `src/utils/xml.test.ts` plus each migrated adapter's fixture test. Gate green.

**Commit:** `refactor(sources): one XML parser for the fifteen XML adapters`.
