# Alexandria v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the public `The-40-Thieves/alexandria-mcp` server from 60 partly-broken sources with a hand-written router to ~120 verified sources across four adapter kinds, a metered and cached fan-out, embedding-first two-stage routing with a measured gate, a web tier, and an answer/research layer, released as 10.0.0.

**Architecture:** Keep the seven coarse MCP tools and Express/Streamable-HTTP server on `@modelcontextprotocol/sdk` 1.30 (the v2 SDK migration is a separate later project). Extend the adapter contract with metadata (kind, cluster, freshness, timeout, headers, auth, pacing, verifiedAt) and wrap every adapter in `getAdapter()` with timeout, pacing, a daily quota ledger, and a short result cache so all tools inherit them. Sources are registered from focused files by kind: `rest` (one file per source, as today), `rss` (one file, many feed configs, feedsmith), `hub` (rest with richer query semantics), `mcp` (delegation to a hosted MCP server through a pooled client). Routing becomes registry-generated and two-stage. A per-role provider table fronts every LLM and embedding call so the same build runs against OpenAI, LiteLLM, or Cloudflare AI Gateway by env alone. Optional infrastructure (SearXNG, Crawl4AI, LiteLLM, Supabase, knowledge MCP) is env-gated: a source or feature registers only when its URL or key is present.

**Tech Stack:** TypeScript 5, Node 22+, `@modelcontextprotocol/sdk` ^1.30 (server and client), Express 5, zod 4, openai ^7 (OpenAI-compatible client for every role), feedsmith ^2 (RSS/Atom/RDF/JSON Feed), fast-xml-parser, node-html-parser, p-limit, defuddle (readability), `node:test` + tsx for tests, osv-scanner and Biome for gates.

**Spec:** the three review pages published 2026-09-01 (Upgrade Assessment, v2 Plan Review, Round Two: `https://claude.ai/code/artifact/a1b2294f-b487-4458-8c43-b03888d3a11b`, `.../1451c895-a893-48e2-a5a9-1db1d64fb2c9`, `.../df46f8a3-4e34-4670-8323-2d7c23656b34`) and the vault decisions `09-reference/decisions/2026-05-22-alexandria-phase-b-architecture.md`, `-adapter-architecture.md`, `2026-07-03-alexandria-model-provider-abstraction.md`, `2026-07-16-alexandria-source-portfolio-and-quota-scoping.md`. Linear: THE-126, THE-130, THE-166, THE-311, THE-312, THE-313, THE-315, THE-317, THE-318, THE-319, THE-320.

## Global Constraints

- Node `>=22.0.0` (package.json engines). Public package name `@the-40-thieves/alexandria-mcp`; `.npmrc` is scoped; never run npm with a global registry override in this repo.
- Stay on `@modelcontextprotocol/sdk` ^1.30 for both server and client; do not migrate to the 2.x packages in this plan.
- Keep exactly the seven public tools until Stage 10 adds `library_answer` and `library_research` (nine total). `tools/list` must not vary per connection.
- Every adapter registers with `supportsIngest` set honestly. `trove` stays `supportsIngest: false` and keeps its full-text cap (NLA data agreement). `youtube` stays `supportsIngest: false`.
- No new required env vars for the default path. Every key, URL, or optional backend is read from env and its feature is skipped, not failed, when absent. Keys will be loaded later by the owner.
- Gate for every task: `npm ci` exit 0, `npm run build` exit 0, `npx tsx --test --test-reporter=tap 'src/**/*.test.ts'` with `# fail 0`, `npm run probe` (Stage 0) not worse than the previous task's probe on any source the task touched, `osv-scanner scan source --recursive .` reports no new vulnerabilities.
- Commit per task with `git commit -s`, message ending in the two attribution trailers used in this repo's history (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_015EfHEzGgtpz7S6BLrn9Tge`). Open a PR per stage against `main`; squash-merge once green.
- Never log or return credential values. (Error strings may include URLs; the owner has said that is acceptable on this deployment. Do not spend effort on redaction.)
- No em dashes in docs or code comments written for this plan.
- Repo conventions from the owner's other repos: add `mise.toml` (pin node) and a `justfile` whose recipes wrap the npm scripts, so `just` lists the tasks.

---

## File Structure

```
src/
  index.ts                     server + 7 (then 9) tools; unchanged shape, reads counts from registry
  types.ts                     LibrarySource becomes `string` alias; result types gain `cluster`/`published`
  sources/
    registry.ts                contract v2, register(), getAdapter() wrapper (timeout, pacing, ledger, cache), listSources() with metadata, catalog()
    kinds/
      rest.ts                  defineRest(): helper for thin-REST adapters (buildUrl, auth injection, normalize)
      rss.ts                   defineRssKind(): one adapter per feed config, feedsmith parsing, Google News RSS search
      mcp.ts                   defineMcpSource(): delegation via McpClientPool
    feeds/                     rss feed config tables (security.ts, regional.ts, standards.ts)
    <name>.ts                  one file per rest/hub source (existing 60 minus drops, plus ~45 new)
  utils/
    http.ts                    existing; adds per-call headers merge and timeout param passthrough (no behavior change)
    rateLimit.ts               existing pacing; unchanged
    quotaLedger.ts             THE-311: daily caps per source, memory store + optional Supabase RPC store
    resultCache.ts             THE-166: TTL cache for search results
    mcpClientPool.ts           pooled Streamable HTTP clients to remote MCP servers, bearer headers, tools/list snapshot
    providers.ts               THE-318: getClient(role) from env, embeddings(), chat(), with fallback chain
    fuse.ts                    RRF fusion + optional LLM listwise rerank
  tools/
    libraryAsk.ts              routing v2: catalog from registry, stage-1 embedding/BM25 candidates, stage-2 LLM selection, fan-out
    libraryAnswer.ts           retrieve, fuse, synthesize with citations
    libraryResearch.ts         recursive loop over libraryAnswer with gaps and follow-ups
  web/
    fetchTier.ts               Defuddle -> Jina Reader -> Crawl4AI chain, used by web sources' read()
scripts/
  probe.ts                     `npm run probe`: one search per source, writes probe.json + table; exit 1 on regression vs baseline
  gen-docs.ts                  `npm run docs`: README source tables, .env.example keys, counts, from the registry
  eval-routing.ts              `npm run eval:routing`: nDCG@k over eval/routing-golden.yaml
eval/
  routing-golden.yaml          labeled query -> expected sources
  fixtures/<source>.json       recorded upstream responses for unit tests
docs/
  superpowers/plans/2026-09-01-alexandria-v2.md  this plan
  sources.md                   generated per-source table (kind, cluster, auth env, verifiedAt)
.github/workflows/
  ci.yml                       build + test + osv on PR
  probe.yml                    weekly scheduled probe; opens/updates an issue on regressions
mise.toml, justfile
```

---

## Stage 0: Baseline, probe command, repo scaffolding

### Task 0.1: Probe script and baseline

**Files:**
- Create: `scripts/probe.ts`
- Create: `eval/probe-baseline.json` (generated)
- Modify: `package.json` (scripts)
- Create: `mise.toml`, `justfile`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run probe [-- --source=<name>] [--baseline]` writing `eval/probe-latest.json` shaped `{ generatedAt: string, results: Record<string, { status: 'OK'|'EMPTY'|'ERROR'|'TIMEOUT', ms: number, count: number, message?: string }> }` and printing a table. Exit code 1 if any source that was `OK` in `eval/probe-baseline.json` is not `OK` now (regression). `--baseline` rewrites the baseline file.
- Consumes: `listSources()` and `getAdapter()` from `src/sources/registry.ts`; a per-source query map `PROBE_QUERIES` (default `"history of science"`, with overrides for sources that need a domain query, e.g. `gallica: "histoire des sciences"`, `projectruneberg: "Ibsen"`, `cervantes: "Quijote"`, `legislationscot: "education"`, `codewiki: "react hooks"`, `youtube: "lecture"`, `ctext: "analects"`, `openiti: "hadith"`, `nasa: "mars rover"`, `base: "machine learning"`).

- [ ] **Step 1: Write the probe test (unit, no network)**

`scripts/probe.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, regressions } from './probe.js';

test('probe classification', async (t) => {
  await t.test('OK when results present', () => {
    assert.equal(classify({ results: [{ id: '1' }] as any, error: null }), 'OK');
  });
  await t.test('EMPTY when zero results', () => {
    assert.equal(classify({ results: [], error: null }), 'EMPTY');
  });
  await t.test('TIMEOUT when aborted', () => {
    assert.equal(classify({ results: null, error: new Error('This operation was aborted') }), 'TIMEOUT');
  });
  await t.test('ERROR otherwise', () => {
    assert.equal(classify({ results: null, error: new Error('HTTP 500') }), 'ERROR');
  });
  await t.test('regressions lists sources that were OK and are not', () => {
    const base = { a: { status: 'OK' }, b: { status: 'ERROR' } } as any;
    const now = { a: { status: 'ERROR' }, b: { status: 'OK' } } as any;
    assert.deepEqual(regressions(base, now), ['a']);
  });
});
```

- [ ] **Step 2: Run it, expect failure** — `npx tsx --test scripts/probe.test.ts` fails: module not found.

- [ ] **Step 3: Implement `scripts/probe.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import '../src/sources/all.js'; // Stage 1 creates this barrel; until then import the list from src/index.ts sources block
import { listSources, getAdapter } from '../src/sources/registry.js';

export type ProbeStatus = 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT';
export interface ProbeResult { status: ProbeStatus; ms: number; count: number; message?: string }

export const PROBE_QUERIES: Record<string, string> = {
  gallica: 'histoire des sciences', projectruneberg: 'Ibsen', cervantes: 'Quijote',
  legislationscot: 'education', legislation: 'data protection', codewiki: 'react hooks',
  youtube: 'lecture', ctext: 'analects', openiti: 'hadith', nasa: 'mars rover', base: 'machine learning',
};
const DEFAULT_QUERY = 'history of science';

export function classify(x: { results: unknown[] | null; error: Error | null }): ProbeStatus {
  if (x.error) return /abort/i.test(x.error.message) ? 'TIMEOUT' : 'ERROR';
  return (x.results?.length ?? 0) > 0 ? 'OK' : 'EMPTY';
}

export function regressions(base: Record<string, { status: string }>, now: Record<string, { status: string }>): string[] {
  return Object.keys(base).filter(s => base[s].status === 'OK' && now[s]?.status !== 'OK').sort();
}

async function probeOne(name: string): Promise<ProbeResult> {
  const q = PROBE_QUERIES[name] ?? DEFAULT_QUERY;
  const t0 = Date.now();
  try {
    const results = await getAdapter(name).search(q, 2);
    return { status: classify({ results, error: null }), ms: Date.now() - t0, count: results.length };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { status: classify({ results: null, error: e }), ms: Date.now() - t0, count: 0, message: e.message.slice(0, 160) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find(a => a.startsWith('--source='))?.slice(9);
  const writeBaseline = args.includes('--baseline');
  const names = listSources().map(s => s.name).filter(n => !only || n === only);
  const results: Record<string, ProbeResult> = {};
  for (const n of names) { results[n] = await probeOne(n); console.error(`${n.padEnd(20)} ${results[n].status.padEnd(8)} ${String(results[n].ms).padStart(6)}ms ${results[n].message ?? ''}`); }
  const out = { generatedAt: new Date().toISOString(), results };
  fs.mkdirSync('eval', { recursive: true });
  fs.writeFileSync(path.join('eval', writeBaseline ? 'probe-baseline.json' : 'probe-latest.json'), JSON.stringify(out, null, 2));
  const counts = Object.values(results).reduce((m, r) => (m[r.status] = (m[r.status] ?? 0) + 1, m), {} as Record<string, number>);
  console.error(JSON.stringify(counts));
  if (!writeBaseline && fs.existsSync('eval/probe-baseline.json') && !only) {
    const base = JSON.parse(fs.readFileSync('eval/probe-baseline.json', 'utf8')).results;
    const bad = regressions(base, results);
    if (bad.length) { console.error(`REGRESSION: ${bad.join(', ')}`); process.exit(1); }
  }
}
if (process.argv[1]?.endsWith('probe.ts') || process.argv[1]?.endsWith('probe.js')) main();
```
Until Stage 1 exists, replace the `all.js` import with the same list of `import '../src/sources/<name>.js'` lines that `src/index.ts` has (copy them; Stage 1 removes the duplication).

- [ ] **Step 4: Scripts and scaffolding**

`package.json` scripts: `"probe": "npx tsx scripts/probe.ts"`, `"probe:baseline": "npx tsx scripts/probe.ts --baseline"`, `"test": "npx tsx --test --test-reporter=spec 'src/**/*.test.ts' 'scripts/**/*.test.ts'"`, `"lint": "biome check ."` (add `@biomejs/biome` devDependency and a default `biome.json`), `"gate": "npm run build && npm test && npm run lint"`.

`mise.toml`:
```toml
[tools]
node = "22"
```
`justfile`:
```
default:
    @just --list
build:
    npm run build
test:
    npm test
probe *ARGS:
    npm run probe -- {{ARGS}}
gate:
    npm run gate
```
`.github/workflows/ci.yml`: on pull_request and push to main: `actions/checkout@v4`, `actions/setup-node@v4` node 22 with npm cache, `npm ci`, `npm run build`, `npm test`, `npx biome ci .`.

- [ ] **Step 5: Run unit test, build, then record the baseline** — `npm run probe:baseline` (network; takes ~5 min). Commit `eval/probe-baseline.json`. Expected today: 33 OK, 8 EMPTY, 19 ERROR.

- [ ] **Step 6: Commit** — `chore: probe command, baseline, mise/justfile, CI`.

---

## Stage 1: Adapter contract v2 and the registry wrapper

### Task 1.1: Contract, metadata, barrel, catalog

**Files:**
- Modify: `src/sources/registry.ts`
- Modify: `src/types.ts` (make `LibrarySource = string`; add `published?: string` and `url?: string` to `LibraryResult`)
- Create: `src/sources/all.ts` (barrel importing every source file; `src/index.ts` and `scripts/probe.ts` import it)
- Modify: `src/index.ts` (drop the hand-written `ALL_SOURCES`; `SourceSchema = z.string()` validated at call time via `getAdapter`; counts from `listSources().length`)
- Test: `src/sources/registry.test.ts` (extend the existing one)

**Interfaces (produces):**
```ts
export type SourceKind = 'rest' | 'hub' | 'rss' | 'mcp' | 'scrape';
export type Freshness = 'realtime' | 'daily' | 'static';
export type Cluster =
  | 'literature' | 'culture' | 'archives' | 'academic' | 'science' | 'government' | 'law'
  | 'security' | 'developer' | 'standards' | 'markets' | 'economics' | 'real_estate'
  | 'news_global' | 'news_regional' | 'geopolitical' | 'ai_research' | 'video' | 'web';
export interface AuthSpec { type: 'none' | 'query' | 'header' | 'bearer'; env?: string; param?: string; header?: string }
export interface SourceMeta {
  kind: SourceKind;
  cluster: Cluster;
  freshness: Freshness;
  homepage?: string;
  timeoutMs?: number;          // default 15000
  headers?: Record<string, string>;
  auth?: AuthSpec;             // informational + used by kinds/rest.ts
  pacing?: { minIntervalMs?: number; dailyCap?: number };
  verifiedAt?: string;         // ISO date the adapter was last probed OK by a human/CI
  hidden?: boolean;            // registered but excluded from routing (e.g., needs a key not present)
}
export interface SourceAdapter extends Partial<SourceMeta> {
  description: string;
  supportsIngest: boolean;
  search(query: string, limit: number): Promise<LibraryResult[]>;
  read(id: string): Promise<ReadResult>;
}
export function register(name: string, adapter: SourceAdapter): void;
export function getAdapter(name: string): SourceAdapter;           // returns the WRAPPED adapter (Task 1.2)
export function listSources(): Array<{ name: string; description: string; supportsIngest: boolean } & SourceMeta>;
export function catalog(): Array<{ name: string; description: string; cluster: Cluster; freshness: Freshness; kind: SourceKind }>; // routing view, excludes hidden
export function isConfigured(auth?: AuthSpec): boolean; // true when auth.type==='none' or env present
```
Defaults applied at `register()`: `kind: 'rest'`, `cluster: 'literature'`, `freshness: 'static'`, `timeoutMs: 15000`. Registration records `hidden = adapter.hidden ?? (adapter.auth ? !isConfigured(adapter.auth) : false)` so keyless sources route and keyed-but-unconfigured sources stay callable by name but are left out of `library_ask` routing.

- [ ] **Step 1: Tests** in `src/sources/registry.test.ts`:
```ts
test('registry v2', async (t) => {
  await t.test('applies defaults and exposes metadata', () => {
    register('t_defaults', { description: 'x', supportsIngest: false, async search() { return []; }, async read() { return { title: '', authors: [] }; } });
    const s = listSources().find(x => x.name === 't_defaults')!;
    assert.equal(s.kind, 'rest'); assert.equal(s.freshness, 'static'); assert.equal(s.timeoutMs, 15000);
  });
  await t.test('keyed source without env is hidden from catalog but still resolvable', () => {
    delete process.env.T_KEY;
    register('t_keyed', { description: 'x', supportsIngest: false, auth: { type: 'query', env: 'T_KEY', param: 'key' }, async search() { return []; }, async read() { return { title: '', authors: [] }; } });
    assert.ok(!catalog().some(c => c.name === 't_keyed'));
    assert.ok(getAdapter('t_keyed'));
  });
});
```
- [ ] **Step 2: Run, expect failure** (catalog undefined).
- [ ] **Step 3: Implement** per the interface above. Keep `truncateText` and `READ_MAX_CHARS` where they are.
- [ ] **Step 4: Create `src/sources/all.ts`** with one `import './<name>.js';` per existing source file except `feedbooks.ts` and `base.ts` (deleted in Stage 3; delete them now and drop their imports; leave `harvardlib` in). Update `src/index.ts` to `import './sources/all.js'`, replace `ALL_SOURCES` uses with `listSources()`, and make `SourceSchema` a `z.string()` with a description that says to call `library_list_sources`. `library_list_sources` output gains kind and cluster: `${name} [${kind}/${cluster}] [${supportsIngest ? 'full text' : 'metadata'}]: ${description}`.
- [ ] **Step 5: Gate and commit** — `feat(registry): adapter contract v2 with metadata, barrel, catalog`.

### Task 1.2: The wrapper: timeout, pacing, ledger, cache

**Files:**
- Create: `src/utils/quotaLedger.ts`, `src/utils/resultCache.ts`
- Modify: `src/sources/registry.ts` (`getAdapter()` returns `withGuards(name, adapter)`)
- Modify: `src/utils/http.ts` (no behavior change; export `DEFAULT_TIMEOUT_MS`)
- Test: `src/utils/quotaLedger.test.ts`, `src/utils/resultCache.test.ts`, `src/sources/registry.test.ts`

**Interfaces (produces):**
```ts
// quotaLedger.ts
export class QuotaExceededError extends Error { constructor(public source: string, public used: number, public cap: number) { super(`Daily quota for ${source} reached (${used}/${cap}). Try again after 00:00 UTC.`); } }
export interface LedgerStore { get(source: string, day: string): Promise<number>; increment(source: string, day: string): Promise<number>; }
export class MemoryLedgerStore implements LedgerStore { /* Map<string, number> keyed `${source}:${day}` */ }
export class SupabaseLedgerStore implements LedgerStore { constructor(url: string, serviceKey: string) {} /* rpc('increment_quota', { p_source, p_day }) and select count from quota_ledger */ }
export function utcDay(now = new Date()): string;            // 'YYYY-MM-DD'
export function createLedger(): LedgerStore;                  // Supabase when SUPABASE_URL+SUPABASE_SERVICE_ROLE_KEY set and ALEXANDRIA_LEDGER=supabase, else memory
export async function enforceQuota(source: string, cap: number | undefined, store: LedgerStore): Promise<void>;
export async function recordUsage(source: string, store: LedgerStore): Promise<void>;

// resultCache.ts
export class ResultCache<T> { constructor(ttlMs: number, max = 500) {} get(key: string, now = Date.now()): T | undefined; set(key: string, value: T, now = Date.now()): void; }
export const searchCache: ResultCache<LibraryResult[]>;      // ttl from ALEXANDRIA_CACHE_TTL_MS (default 600000); 0 disables
export function cacheKey(source: string, query: string, limit: number): string; // `${source}|${query.trim().toLowerCase().replace(/\s+/g,' ')}|${limit}`
```
Wrapper semantics in `withGuards`:
1. `search(q, limit)`: cache hit returns immediately (cache hits do not consume quota, per THE-166). Else `enforceQuota(name, meta.pacing?.dailyCap, ledger)`, then run under `rateLimited(name, meta.pacing?.minIntervalMs ?? 0, ...)` with an `AbortSignal.timeout(meta.timeoutMs)` passed through by temporarily setting `process.env` free: instead, wrap the promise with `withTimeout(p, meta.timeoutMs)` which rejects with `Error('This operation was aborted')` for parity with existing messages. `recordUsage` in `finally` (failures count, as in rateLimit.ts). Store in cache on success.
2. `read(id)`: same minus cache.
3. SQL for the Supabase store lives in `docs/sql/quota_ledger.sql` exactly as scoped in THE-311 (table `quota_ledger(source, day, count, updated_at)` primary key `(source, day)`, function `increment_quota(p_source text, p_day date) returns integer` doing `insert ... on conflict do update set count = count + 1 returning count`).

- [ ] **Step 1: Tests**: ledger under-cap passthrough, at-cap throws `QuotaExceededError`, uncapped never throws, failure still records; cache get/set/expiry and key normalization; registry wrapper: a fake adapter with `pacing.dailyCap: 2` throws on the third call within the same UTC day, and a second identical search is served from cache without calling the adapter (count calls with a counter).
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.** Keep `getAdapter` returning a stable wrapped object per name (memoize in a `Map`) so identity comparisons and hot paths stay cheap.
- [ ] **Step 4: Gate.** Probe must equal baseline (wrapper is transparent with no metadata).
- [ ] **Step 5: Commit** — `feat(registry): guard adapters with timeout, pacing, daily quota ledger, result cache (THE-311, THE-166)`.

---

## Stage 2: Repair the existing sources

One task per group; each task ends with `npm run probe -- --source=<name>` OK for every source it touched, and metadata (`cluster`, `freshness`, `auth`, `pacing`, `timeoutMs`, `homepage`, `verifiedAt: '2026-09-0X'`) added to every adapter it touches. Use the fixtures pattern: record one real response into `eval/fixtures/<source>.json` and unit-test the normalize function against it, so tests do not hit the network.

### Task 2.1: Endpoint migrations (literature, culture, archives)

**Files:** `src/sources/{chroniclingamerica,datagov,ctext,hathitrust,ndl,europeana,nara,gutenberg,standardebooks,earlyprint,ora,dpla,digitalnz,gallica,perseus,apollo,cervantes,sacredtexts}.ts` plus fixtures and tests.

Per-source spec (endpoint, then the mapping):

| Source | New request | Normalize |
|---|---|---|
| chroniclingamerica | `GET https://www.loc.gov/collections/chronicling-america/?q={q}&fo=json&c={limit}` | `results[]`: id=`item.id` (URL), title=`item.title`, year=`item.date?.slice(0,4)`, previewUrl=`item.id`, hasFullText=true, url=`item.id`. read(): `GET {id}?fo=json` then `item.full_text` if present else `results[0].full_text`; fall back to LoC text-services `https://www.loc.gov/resource/{resourceId}/?fo=json&st=text` when only the resource id is known |
| datagov | `GET https://catalog.data.gov/search?q={q}&size={limit}` (JSON) | `hits[]` or `results[]`: id=slug, title, description, previewUrl=`https://catalog.data.gov/dataset/{slug}`, hasFullText=false. read(): `GET https://catalog.data.gov/api/dataset/{slug}` metadata-only |
| ctext | search: `GET https://api.ctext.org/searchtexts?title={q}` ; read: `GET https://api.ctext.org/gettextinfo?urn={id}` then `gettext?urn={chapterUrn}` per chapter with the existing p-limit(5) and 300 ms sleep | keep current shapes; ids become `ctp:` URNs |
| hathitrust | Data API is retired. Search is not possible; make `search()` return `[]` with `description` stating "lookup by OCLC/ISBN/htid only" and implement read(id) with `GET https://catalog.hathitrust.org/api/volumes/brief/{oclc|isbn|htid}/{value}.json`, id format `oclc:424023` etc. | metadataOnly |
| ndl | `GET https://ndlsearch.ndl.go.jp/api/sru?operation=searchRetrieve&version=1.2&query=anywhere%3D%22{q}%22&maximumRecords={limit}&recordSchema=dcndl_simple` | parse XML with fast-xml-parser; title=`dc:title`, authors=`dc:creator[]`, year from `dcterms:issued`, previewUrl=`dc:identifier` https link |
| europeana | `GET https://api.europeana.eu/record/v2/search.json?query={q}&rows={limit}&qf=TYPE:TEXT&wskey={EUROPEANA_API_KEY}` (header `X-Api-Key` also accepted; send both) | `items[]`: id, title[0], dcCreator[], year, previewUrl=`guid`, hasFullText=`Boolean(edmIsShownBy)`. `auth: { type:'query', env:'EUROPEANA_API_KEY', param:'wskey' }`; the public test key is removed |
| nara | `GET https://catalog.archives.gov/api/v2/records/search?q={q}&limit={limit}` with header `x-api-key: {NARA_API_KEY}` | `body.hits.hits[]._source.record`: title, naId, previewUrl=`https://catalog.archives.gov/id/{naId}`; `auth:{type:'header',env:'NARA_API_KEY',header:'x-api-key'}` |
| gutenberg | `GET https://gutendex.com/books/?search={q}` (trailing slash) | unchanged mapping |
| standardebooks | `GET https://standardebooks.org/ebooks?query={q}` HTML; parse `li` entries with node-html-parser: title `p a`, author `p.author a`, href | read(): `https://standardebooks.org{href}/text/single-page` HTML to text. `kind:'scrape'` |
| earlyprint | keep, `hidden: true` until the catalog returns; description notes it | none |
| ora | `GET https://ora.ox.ac.uk/objects?q={q}&format=json&per_page={limit}` | `data[]`: id, title, creators, year; previewUrl=`https://ora.ox.ac.uk/objects/{id}` |
| dpla | keep endpoint; remove `fields` param; add `auth:{type:'query',env:'DPLA_API_KEY',param:'api_key'}` | `docs[]` |
| digitalnz | `GET https://api.digitalnz.org/v3/records.json?text={q}&per_page={limit}` with `api_key` query if set (works keyless) | `search.results[]` |
| gallica | SRU: `query=(gallica all "{q}")` must be URL-encoded once; current code double-encodes. Parse `srw:record` and `dc:title` via fast-xml-parser with `removeNSPrefix: true` | verify by fixture |
| perseus | replace any `scaife-cts` URL with `https://scaife.perseus.org/library/{urn}/json/`; search stays over the local catalogue list | none |
| apollo | host `https://api.repository.cam.ac.uk/server/api/discover/search/objects?query={q}&size={limit}` | `_embedded.searchResult._embedded.objects[]._embedded.indexableObject` |
| cervantes | replace scraping with SPARQL: `POST https://data.cervantesvirtual.com/sparql` `query=SELECT ?work ?title ?author WHERE { ?work a <http://purl.org/dc/terms/BibliographicResource>; <http://purl.org/dc/terms/title> ?title . OPTIONAL { ?work <http://purl.org/dc/terms/creator> ?author } FILTER(CONTAINS(LCASE(STR(?title)), LCASE("{q}"))) } LIMIT {limit}` with `Accept: application/sparql-results+json` | bindings |
| sacredtexts | keep the curated registry search; read() sets `metadataOnly: true` with a note that the live site is bot-gated | none |

For each: (1) record fixture, (2) test normalize against fixture, (3) implement, (4) `npm run probe -- --source=X` OK, (5) commit `fix(<source>): ...`.

### Task 2.2: Keys, pacing, quota metadata (academic, science, law)

**Files:** `src/sources/{semanticscholar,core,openalex,courtlistener,zenodo,arxiv,googlebooks,loc,openiti,govinfo,biorxiv,nasa,harvardlib,youtube,trove}.ts`

| Source | Change |
|---|---|
| semanticscholar | send `x-api-key: {SEMANTIC_SCHOLAR_API_KEY}` on every request (search, paper, recommendations); `pacing: { minIntervalMs: 1100 }`; on 429 read `Retry-After` and sleep once before failing |
| core | `Authorization: Bearer {CORE_API_KEY}`; path `/search/works/` (trailing slash); `pacing: { minIntervalMs: 2100 }` |
| openalex | `api_key={OPENALEX_API_KEY}` query when set, else `mailto={CONTACT_EMAIL}`; `pacing: { dailyCap: 900 }` (the free key is $1/day at $0.001 per search); read `meta.cost_usd` if present and log at debug |
| courtlistener | `Authorization: Token {COURTLISTENER_API_KEY}`; `pacing: { minIntervalMs: 12000, dailyCap: 120 }` (125/day authenticated cap since 2026-05-07) |
| zenodo | `pacing: { minIntervalMs: 2100 }`; honor `retry-after` |
| arxiv | `https://export.arxiv.org` (https), `pacing: { minIntervalMs: 3100 }`, single connection |
| googlebooks | require `GOOGLE_BOOKS_API_KEY` via `auth` (keyless shared quota is exhausted) |
| loc | `pacing: { minIntervalMs: 3100 }` (20/min) |
| openiti | `Authorization: Bearer {GITHUB_TOKEN}`; fall back to unauthenticated raw-file search when missing |
| govinfo | search is `POST https://api.govinfo.gov/search?api_key=...` with body `{ query, pageSize, offsetMark: '*', resultLevel: 'default' }` |
| biorxiv | no free-text search exists: implement `search()` as a date-window listing `GET https://api.biorxiv.org/details/biorxiv/{from}/{to}/0` for the last 7 days filtered client-side by title/abstract match; document the limitation in `description` |
| nasa | fix: NTRS expects `GET https://ntrs.nasa.gov/api/citations/search?q={q}&page[size]={limit}`; map `results[]` |
| harvardlib | keep; `hidden: true` with note "429 from load balancer for datacenter clients as of 2026-09"; revisit |
| youtube | `read()` prefers Supadata when `SUPADATA_API_KEY` is set: `GET https://api.supadata.ai/v1/youtube/transcript?videoId={id}&text=true` header `x-api-key`; else the existing ANDROID_VR path. `search()` unchanged (needs `YOUTUBE_API_KEY`; `pacing: { dailyCap: 90 }`) |
| trove | implement full-text `read()` behind `TROVE_API_KEY`: `GET https://api.trove.nla.gov.au/v3/work/{id}?encoding=json&include=all&reclevel=full` for metadata and, where `fulltext` links exist, `GET https://api.trove.nla.gov.au/v3/newspaper/{articleId}?include=articleText&encoding=json` for newspaper articles; keep `recordFullTextRead()` on every read that returns text; `supportsIngest` stays false |

Gate: probe OK for every source whose key is present in the environment; sources whose keys are absent must return the clear "requires KEY" error and be `hidden` in the catalog (the probe reports them as ERROR and that is expected; the baseline is updated to mark them `KEY_MISSING` by adding that status to `classify()` when the message matches `/requires .* key/i`).

### Task 2.3: Drops and metadata sweep

Delete `feedbooks.ts`, `base.ts`, `oapen.ts`, `crossref.ts` if still present. Add `cluster`, `freshness`, `homepage`, `verifiedAt` to every remaining adapter that Tasks 2.1 and 2.2 did not touch (table in `docs/sources.md` generated in Stage 8 will show gaps). Update `README.md` counts via the generator only (do not hand-edit counts). Re-baseline the probe: `npm run probe:baseline`. Commit `chore(sources): drop retired sources, metadata sweep, new probe baseline`.

---

## Stage 3: RSS kind

### Task 3.1: feedsmith kind and feed tables

**Files:**
- Create: `src/sources/kinds/rss.ts`, `src/sources/feeds/security.ts`, `src/sources/feeds/regional.ts`, `src/sources/feeds/standards.ts`, `src/sources/googlenews.ts`
- Test: `src/sources/kinds/rss.test.ts` with fixture feeds in `eval/fixtures/rss/*.xml`
- Modify: `package.json` (add `feedsmith`)

**Interfaces:**
```ts
export interface FeedConfig { name: string; url: string; description: string; cluster: Cluster; region?: string; homepage: string; freshness?: Freshness; timeoutMs?: number; headers?: Record<string, string> }
export function defineRssSource(cfg: FeedConfig): void;   // registers one source per feed; search() fetches the feed (cached 10 min by the registry cache), filters items by case-insensitive token match on title+summary, returns up to limit newest-first; read(id=item link) uses web/fetchTier (Stage 6) once it exists, until then returns metadataOnly with externalUrl
export function parseFeedItems(xmlOrJson: string): Array<{ id: string; title: string; link: string; published?: string; summary?: string; authors: string[] }>; // feedsmith parseFeed(), normalized across RSS 2.0, Atom, RDF, JSON Feed
```
Feed tables (all verified live 2026-09-01): security: Exploit-DB `https://www.exploit-db.com/rss.xml`, MSRC `https://api.msrc.microsoft.com/update-guide/rss`, Project Zero `https://projectzero.google/feed.xml`, Cisco `https://sec.cloudapps.cisco.com/security/center/psirtrss20/CiscoSecurityAdvisory.xml`, BleepingComputer `https://www.bleepingcomputer.com/feed/`. Regional: AllAfrica `https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf`, Arab News `https://www.arabnews.com/rss.xml`, The Hindu international `https://www.thehindu.com/news/international/feeder/default.rss`, ABC World `https://www.abc.net.au/news/feed/104217382/rss.xml`, Folha EN `https://feeds.folha.uol.com.br/internacional/en/rss091.xml`, DW `https://rss.dw.com/rdf/rss-en-all`, France 24 `https://www.france24.com/en/rss`, Al Jazeera `https://www.aljazeera.com/xml/rss/all.xml`, Al-Monitor `https://www.al-monitor.com/rss`, The Diplomat `https://thediplomat.com/feed/`, Nikkei Asia `https://asia.nikkei.com/rss/feed/nar`, Daily Maverick `https://www.dailymaverick.co.za/rss/`, Rest of World `https://restofworld.org/feed/latest/`, SCMP `https://www.scmp.com/rss/91/feed`. NHK is JSON: `https://www3.nhk.or.jp/nhkworld/data/en/news/all.json` (items `data[]` with `title`, `description`, `page_url`), handled by a tiny `nhk.ts` rest adapter, not the RSS kind. Standards: NIST CSRC publications RSS `https://csrc.nist.gov/CSRC/media/feeds/publications/all.xml`.
`googlenews.ts`: `search()` fetches `https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en` through `parseFeedItems`; cluster `news_global`, freshness `realtime`.

Steps: fixture tests for RSS 2.0, Atom, RDF; implement; register feeds; probe each new source; commit `feat(rss): feedsmith kind with 17 verified feeds and Google News search`.

---

## Stage 4: Hub and REST adapters (Phase B)

Each adapter is one file using `defineRest()` from `src/sources/kinds/rest.ts` (Task 4.0). Each task records a fixture per source, tests the normalize function, probes live, and commits per source. Auth uses `AuthSpec`; when the key env is missing the source is registered hidden and `search()` throws `"<name> requires <ENV>"`.

### Task 4.0: `defineRest()` helper

```ts
export interface RestSpec<TRaw> {
  name: string; description: string; cluster: Cluster; freshness: Freshness; homepage: string;
  supportsIngest: boolean; auth?: AuthSpec; pacing?: SourceMeta['pacing']; timeoutMs?: number; headers?: Record<string,string>;
  search: { url: (q: string, limit: number) => string; method?: 'GET'|'POST'; body?: (q: string, limit: number) => unknown; pick: (raw: TRaw) => unknown[]; normalize: (item: any, q: string) => LibraryResult | null };
  read?: { url: (id: string) => string; normalize: (raw: any, id: string) => ReadResult };
}
export function defineRest<TRaw>(spec: RestSpec<TRaw>): void; // builds search/read with fetchJSON, injects auth (query param, header, or bearer), applies headers, registers with metadata; nulls from normalize are dropped
```
Test with a fake `fetch` (monkeypatch `globalThis.fetch`) verifying query-param and bearer injection and null-dropping.

### Task 4.1: security cluster (10)

| Name | Search request | Pick / normalize | Read | Auth / pacing |
|---|---|---|---|---|
| circl | `GET https://vulnerability.circl.lu/api/vulnerability/fulltext?q={q}&page=1&per_page={limit}` | items: id=`vulnerability id`, title=id + first 80 chars of description, description, year from published, previewUrl=`https://vulnerability.circl.lu/vuln/{id}` | `GET /api/vulnerability/{id}` to text: summary, CVSS, references | none |
| osv | `POST https://api.osv.dev/v1/query` body `{ "package": { "name": q } }` when q looks like a package name, else `{ "query": q }` is not supported: use `GET https://api.osv.dev/v1/vulns/{q}` when q matches `/^(CVE|GHSA|PYSEC|RUSTSEC|GO)-/`, otherwise package query; pick `vulns[]` | id, summary as title, `details` as description, modified year | `GET /v1/vulns/{id}` | none |
| ghsa | `GET https://api.github.com/advisories?keywords={q}&per_page={limit}` | ghsa_id, summary, description, published year, html_url | `GET /advisories/{ghsa_id}` | bearer `GITHUB_TOKEN` optional (60/h without) |
| kev | `GET https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` (cached 10 min by registry), filter `vulnerabilities[]` by token match on cveID+vendorProject+product+vulnerabilityName | id=cveID, title=vulnerabilityName, previewUrl=`https://nvd.nist.gov/vuln/detail/{cveID}` | metadata | header `User-Agent: alexandria-mcp/10 (+https://github.com/The-40-Thieves/alexandria-mcp)` |
| euvd | `GET https://euvdservices.enisa.europa.eu/api/search?text={q}&size={limit}` | `items[]`: id, description, datePublished, previewUrl=`https://euvd.enisa.europa.eu/vulnerability/{id}` | `GET /api/enisaid?id={id}` | none |
| epss | `GET https://api.first.org/data/v1/epss?cve={q}` only when q is a CVE id; otherwise `[]` | id=cve, title=`{cve} EPSS {epss} percentile {percentile}` | same | none |
| nvd | `GET https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch={q}&resultsPerPage={limit}` header `apiKey` when `NVD_API_KEY` | `vulnerabilities[].cve`: id, descriptions[en].value, published | `?cveId={id}` | `pacing: { minIntervalMs: 6500 }` keyless, 700 with key |
| cwe | `GET https://cwe-api.mitre.org/api/v1/cwe/weakness/{id}` when q matches `/^(CWE-)?\d+$/`; else `[]` (no search endpoint) | id=`CWE-{n}`, name, description | same | none |
| attack | static: download `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json` once per process (lazy, cached in module scope), filter `objects[]` of type `attack-pattern` by token match on name+description | id=external_id (T####), name, description | object description | `freshness:'static'`, `timeoutMs: 60000` |
| (rss) | security feeds registered in Stage 3 | | | |

### Task 4.2: developer and standards clusters (12 + 3)

| Name | Search | Normalize | Read | Auth / notes |
|---|---|---|---|---|
| ecosystems | `GET https://packages.ecosyste.ms/api/v1/packages/search?q={q}&per_page={limit}` with `User-Agent: alexandria-mcp/10 (mailto:{CONTACT_EMAIL})` (402 without a mailto) | name@registry as id, description, latest_release_published_at year, previewUrl=`homepage` or registry_url | `GET /api/v1/registries/{registry}/packages/{name}` | header `CONTACT_EMAIL` required else hidden |
| depsdev | `GET https://api.deps.dev/v3/query?versionKey.system={sys}&versionKey.name={name}` when q is `system:name`, else `GET https://api.deps.dev/v3/systems/npm/packages/{q}` | versions | `GET /v3/systems/{sys}/packages/{name}` | none |
| stackexchange | `GET https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&q={q}&pagesize={limit}&order=desc&sort=relevance&filter=withbody&key={STACKEXCHANGE_KEY}` (gzip is automatic in Node fetch) | question_id, title, creation_date year, link, description=body stripped | `/2.3/questions/{id}/answers?site=stackoverflow&filter=withbody&sort=votes` joined as text | key optional |
| hn | `GET https://hn.algolia.com/api/v1/search?query={q}&hitsPerPage={limit}` | objectID, title, author, created_at year, url or `https://news.ycombinator.com/item?id=` | `GET /api/v1/items/{id}` comments flattened | none |
| devto | `GET https://dev.to/api/articles?search=... ` is not supported: use `GET https://dev.to/api/articles?tag={q}&per_page={limit}` when q is one token, else `GET https://dev.to/search/feed_content?search_fields={q}&per_page={limit}&class_name=Article` | id, title, user.name, published_at year, url | `GET /api/articles/{id}` `body_markdown` | none |
| lobsters | RSS `https://lobste.rs/rss` via Stage 3 kind | | | |
| githubsearch | `GET https://api.github.com/search/code?q={q}&per_page={limit}` when `GITHUB_TOKEN`, else `/search/repositories?q={q}` | repo full_name#path, html_url | `GET /repos/{owner}/{repo}/contents/{path}` decoded | bearer, `pacing:{minIntervalMs:2100}` |
| peps | `GET https://peps.python.org/api/peps.json` (cached), filter by number/title token | id=`PEP {n}`, title, authors, created year, url | `https://peps.python.org/pep-{n}/` HTML to text via fetchTier | none, static |
| tc39 | `GET https://tc39.es/dataset/proposals.json` filter by name/description | id, name, authors, stage in description, url | metadata | static |
| swiftevolution | `GET https://download.swift.org/swift-evolution/v1/evolution.json` filter `proposals[]` | id (SE-####), title, authors, status | metadata | static |
| mdn | `GET https://developer.mozilla.org/api/v1/search?q={q}&locale=en-US&size={limit}` | `documents[]`: mdn_url as id, title, summary | `https://developer.mozilla.org{mdn_url}` HTML to text via fetchTier | none |
| context7 | `GET https://context7.com/api/v2/libs/search?query={q}` header `Authorization: Bearer {CONTEXT7_API_KEY}` | `results[]`: id, title, description | `GET https://context7.com/api/v2/context?libraryId={id}&query={q}` | key optional (hidden without); superseded by the `mcp` kind in Stage 5 if that proves more reliable, keep both and prefer mcp when configured |
| ietf | `GET https://datatracker.ietf.org/api/v1/doc/document/?type=rfc&title__icontains={q}&limit={limit}&format=json` | `objects[]`: name (rfcNNNN) as id, title, time year, previewUrl=`https://www.rfc-editor.org/rfc/{name}` | `GET https://www.rfc-editor.org/rfc/{name}.txt` | none |
| w3c | `GET https://api.w3.org/specifications?q={q}&items={limit}` (or filter `_embedded.specifications[]` of `GET https://api.w3.org/specifications?items=1000` cached) | shortname id, title, `_links.latest-version.href` | metadata | none |
| nistcsrc | RSS via Stage 3 | | | |

### Task 4.3: markets, economics, real estate (11)

| Name | Search | Normalize | Read | Auth / pacing |
|---|---|---|---|---|
| twelvedata | `GET https://api.twelvedata.com/symbol_search?symbol={q}&outputsize={limit}` | `data[]`: `{symbol}:{exchange}` id, instrument_name, country in description | `GET /time_series?symbol={symbol}&interval=1day&outputsize=30&apikey=` as a text table | `TWELVEDATA_API_KEY` query `apikey`; `pacing:{minIntervalMs:8000,dailyCap:750}` |
| coingecko | `GET https://api.coingecko.com/api/v3/search?query={q}` header `x-cg-demo-api-key` | `coins[]`: id, name, symbol | `GET /coins/{id}?localization=false&tickers=false&community_data=false&developer_data=false` summarized (price, market cap, description) | `COINGECKO_API_KEY` header optional; `pacing:{minIntervalMs:700}` |
| frankfurter | q like `USD` or `USD EUR`: `GET https://api.frankfurter.dev/v1/latest?base={from}&symbols={to}`; otherwise `GET /v1/currencies` filtered | id=`{base}:{date}`, title=`{base} rates {date}`, description=rates | same | none |
| eia | `GET https://api.eia.gov/v2/seriesid/{q}?api_key=` when q looks like a series id (contains `.`), else `GET https://api.eia.gov/v2/search?query={q}&api_key=` (undocumented; if 404 use `/v2/?api_key=` route listing filtered) | series id, name, units | series data last 30 rows as text | `EIA_API_KEY` query |
| fred | `GET https://api.stlouisfed.org/fred/series/search?search_text={q}&limit={limit}&api_key=&file_type=json` | `seriess[]`: id, title, observation_end year, notes | `GET /fred/series/observations?series_id=&limit=60&sort_order=desc&api_key=&file_type=json` as text | `FRED_API_KEY` |
| dbnomics | `GET https://api.db.nomics.world/v22/search?q={q}&limit={limit}` | `results.docs[]`: `{provider_code}/{dataset_code}` id, dataset name, provider name | `GET /v22/series/{provider}/{dataset}?observations=1&limit=5&format=json` first series as text | none |
| comtrade | `GET https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=&cmdCode={q}&period={year-1}` when q is an HS code; else `[]` with description telling the format | rows summarized | same | `UN_COMTRADE_KEY` header `Ocp-Apim-Subscription-Key` for `/data/v1/get/` when present; `pacing:{dailyCap:450}` |
| census | `GET https://api.census.gov/data.json` (cached) filter `dataset[]` by title/description | c_dataset id, title, modified year, previewUrl=`c_documentationLink` | metadata | `CENSUS_API_KEY` optional |
| openfda | `GET https://api.fda.gov/drug/enforcement.json?search=product_description:"{q}"&limit={limit}` | `results[]`: recall_number id, product_description title, reason_for_recall, report_date year | metadata | `OPENFDA_API_KEY` optional; `pacing:{minIntervalMs:300}` |
| epatri | `GET https://data.epa.gov/efservice/tri_facility/facility_name/CONTAINING/{q}/rows/0:{limit}/JSON` | tri_facility_id, facility_name, city/state description | metadata | none |
| hud | `GET https://www.huduser.gov/hudapi/public/fmr/data/{q}?year={year}` when q is a 5-digit ZIP or state code; header `Authorization: Bearer {HUD_API_TOKEN}` | data summary | same | bearer required (hidden without) |
| rentcast | `GET https://api.rentcast.io/v1/markets?zipCode={q}` header `X-Api-Key` | zip stats | same | `RENTCAST_API_KEY`; `pacing:{dailyCap:1}` (50/month) |

### Task 4.4: news, geopolitical, government, AI research (13)

| Name | Search | Normalize | Read | Auth / pacing |
|---|---|---|---|---|
| gdelt | `GET https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=ArtList&maxrecords={limit}&format=json` `timeoutMs: 45000` | `articles[]`: url id, title, seendate year, domain in description | fetchTier(url) | none, `freshness:'realtime'` |
| newsdata | `GET https://newsdata.io/api/1/latest?q={q}&language=en&apikey=` | `results[]`: article_id, title, pubDate, link, description | fetchTier | `NEWSDATA_API_KEY`; `pacing:{dailyCap:180}` |
| guardian | `GET https://content.guardianapis.com/search?q={q}&page-size={limit}&show-fields=trailText,bodyText&api-key=` | `response.results[]`: id, webTitle, webPublicationDate, webUrl | `GET https://content.guardianapis.com/{id}?show-fields=bodyText&api-key=` | `GUARDIAN_API_KEY`; `pacing:{dailyCap:450}` |
| hapi | `GET https://hapi.humdata.org/api/v2/coordination-context/conflict-events?location_code={iso3}&limit={limit}&app_identifier={HDX_APP_IDENTIFIER}` when q resolves to an ISO3 via a 250-row country table in the file; else `GET /api/v2/metadata/location?name={q}` | rows summarized | same | `HDX_APP_IDENTIFIER` (self-serve) |
| reliefweb | `GET https://api.reliefweb.int/v2/reports?appname={RELIEFWEB_APPNAME}&query[value]={q}&limit={limit}&fields[include][]=title&fields[include][]=date.created&fields[include][]=url&fields[include][]=body` | `data[]`: id, fields.title, date year, url | body | `RELIEFWEB_APPNAME` required |
| ucdp | `GET https://ucdpapi.pcr.uu.se/api/gedevents/26.1?pagesize={limit}&Country={q}` header `x-ucdp-access-token` | `Result[]`: id, headline built from type_of_violence + side_a + side_b, date_start year | metadata | `UCDP_TOKEN` required; `pacing:{dailyCap:4500}` |
| wikicurrent | `GET https://en.wikipedia.org/w/api.php?action=parse&page=Portal:Current_events&prop=text&format=json&formatversion=2` cached, HTML to text, split into day sections, filter by token | id=date, title=`Current events {date}`, description first 300 chars | full day text | none, `freshness:'daily'` |
| federalregister | `GET https://www.federalregister.gov/api/v1/documents.json?per_page={limit}&conditions[term]={q}` | `results[]`: document_number id, title, publication_date, html_url, abstract | `GET /api/v1/documents/{document_number}.json` `body_html_url` fetched via fetchTier | none |
| congress | `GET https://api.congress.gov/v3/bill?api_key=&limit={limit}&q=` is not a search: use `GET https://api.congress.gov/v3/search?query={q}&api_key=` if available in the current ChangeLog, else filter `/v3/bill?sort=updateDate+desc&limit=250` by title token | bill `{congress}-{type}-{number}` id, title, latestAction | `GET /v3/bill/{congress}/{type}/{number}/text?api_key=` first text version | `DATA_GOV_API_KEY` (same family as GovInfo) |
| regulations | `GET https://api.regulations.gov/v4/documents?filter[searchTerm]={q}&page[size]={limit}&api_key=` | `data[]`: id, attributes.title, postedDate, `https://www.regulations.gov/document/{id}` | `GET /v4/documents/{id}?api_key=` | `DATA_GOV_API_KEY` |
| ukparliament | `GET https://bills-api.parliament.uk/api/v1/Bills?SearchTerm={q}&Take={limit}` | `items[]`: billId, shortTitle, currentHouse, `https://bills.parliament.uk/bills/{billId}` | `GET /api/v1/Bills/{id}` summary | none |
| hfpapers | `GET https://huggingface.co/api/papers/search?q={q}` | id (arXiv id), title, authors[].name, publishedAt year, `https://huggingface.co/papers/{id}` | arXiv abs via existing arxiv adapter read | none; `pacing:{minIntervalMs:700}` |
| paperswithcode | `GET https://paperswithcode.co/api/v1/papers/?q={q}&items_per_page={limit}` | id, title, authors, published year, url_abs | metadata | none; `hidden` if the endpoint 5xxs during probe |

Each task: fixture, test, implement, probe, commit per source; final commit per task `feat(sources): <cluster> cluster (<n> sources)`.

---

## Stage 5: MCP delegation kind

### Task 5.1: client pool and `defineMcpSource()`

**Files:** `src/utils/mcpClientPool.ts`, `src/sources/kinds/mcp.ts`, `src/sources/mcp/{huggingface,context7mcp,jina,githubmcp,mdnmcp}.ts`, tests with a local in-process MCP server fixture (`McpServer` + `StreamableHTTPServerTransport` on an ephemeral port).

**Interfaces:**
```ts
// mcpClientPool.ts
export interface RemoteServerConfig { name: string; url: string; headers?: Record<string, string>; timeoutMs?: number }
export class McpClientPool {
  async call(server: RemoteServerConfig, tool: string, args: Record<string, unknown>): Promise<{ text: string; structured?: unknown }>; // creates/reuses a Client+StreamableHTTPClientTransport per server; on any 4xx or transport error, drops the client and retries once with a fresh one
  async tools(server: RemoteServerConfig): Promise<string[]>;      // cached 1h; used by the probe to detect surface drift
}
export const pool: McpClientPool;

// kinds/mcp.ts
export interface McpSourceSpec {
  name: string; description: string; cluster: Cluster; freshness: Freshness; homepage: string; supportsIngest: boolean;
  server: RemoteServerConfig | (() => RemoteServerConfig | null);   // null => not configured => hidden
  search: { tool: string; args: (q: string, limit: number) => Record<string, unknown>; normalize: (text: string, structured: unknown, q: string) => LibraryResult[] };
  read?: { tool: string; args: (id: string) => Record<string, unknown>; normalize: (text: string, structured: unknown, id: string) => ReadResult };
  expectTools?: string[];   // probe asserts these exist in tools/list
}
export function defineMcpSource(spec: McpSourceSpec): void;
```
Servers: Hugging Face `https://huggingface.co/mcp` (`hf_fs` with `{ path: 'hf://papers', query }` per HF docs; normalize the returned listing text into results), Context7 `https://mcp.context7.com/mcp` (`resolve-library-id` then `query-docs`; bearer `CONTEXT7_API_KEY` optional), Jina `https://mcp.jina.ai/v1` (`search_web`, `read_url`, `search_arxiv`; bearer `JINA_API_KEY` optional), GitHub `https://api.githubcopilot.com/mcp/` (`search_code`, `get_file_contents`; bearer `GITHUB_TOKEN` required, hidden without), MDN `https://mcp.mdn.mozilla.net/` (search tool per its tools/list; fall back to the REST `mdn` source if the server is down). Tool names are prefixed `mcp_<server>_` internally to avoid collisions.

Gate: unit tests against the in-process server; live probe of each delegated source; record `tools/list` snapshots in `eval/mcp-tools/<server>.json` and make the probe warn on drift. Commit `feat(mcp): delegation kind with pooled clients; huggingface, context7, jina, github, mdn`.

---

## Stage 6: Web tier (Phase 9)

### Task 6.1: fetch chain and web sources

**Files:** `src/web/fetchTier.ts`, `src/sources/{searxng,jinasearch,tavily,webfetch}.ts`, modify `youtube.ts` read for Supadata (done in 2.2), tests with a local HTTP fixture server.

```ts
export interface FetchedPage { url: string; title: string; text: string; via: 'defuddle' | 'jina' | 'crawl4ai' }
export async function fetchAsText(url: string): Promise<FetchedPage>;
// 1) GET url with a browser UA (timeout 15 s); if HTML and Defuddle extracts >= 500 chars of text, return via 'defuddle'
// 2) else if JINA_API_KEY or ALEXANDRIA_JINA_READER=1: GET https://r.jina.ai/{url} with Accept: text/plain (bearer when key) -> 'jina'
// 3) else if CRAWL4AI_URL: POST {CRAWL4AI_URL}/crawl { urls: [url], crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'bypass' } } } and read results[0].markdown.fit_markdown ?? markdown -> 'crawl4ai'
// throws with the last error when all configured tiers fail
```
Sources: `searxng` (`GET {SEARXNG_URL}/search?q={q}&format=json&categories=general` -> `results[]` url/title/content/publishedDate; hidden without `SEARXNG_URL`; cluster `web`, freshness `realtime`; read = fetchAsText), `jinasearch` (`GET https://s.jina.ai/{q}` with `Accept: application/json`, `X-Respond-With: no-content`; hidden without `JINA_API_KEY` to respect the 20 RPM anonymous cap), `tavily` (`POST https://api.tavily.com/search` `{ query, max_results, include_raw_content: false }` bearer `TAVILY_API_KEY`; hidden without), `webfetch` (search() returns `[]`; read(url) = fetchAsText; lets `library_read(source='webfetch', id=url)` read any page). All web sources `supportsIngest: true`.

Gate: unit tests for tier selection with a fixture server; live: `webfetch` read of `https://www.rfc-editor.org/rfc/rfc9110.html` returns > 5,000 chars via defuddle; SearXNG search from Cave returns results when `SEARXNG_URL=http://100.78.123.100:8888`. Commit `feat(web): fetch tier (defuddle, jina, crawl4ai) and searxng/jina/tavily/webfetch sources`.

---

## Stage 7: Provider abstraction (THE-318)

### Task 7.1: `providers.ts`

```ts
export type Role = 'router' | 'synth' | 'research' | 'embeddings' | 'rerank';
export interface RoleConfig { baseURL: string; apiKey: string; model: string; fallback?: RoleConfig }
export function roleConfig(role: Role): RoleConfig;  // env: ALEXANDRIA_<ROLE>_BASE_URL, _API_KEY, _MODEL; then ALEXANDRIA_BASE_URL/_API_KEY as shared defaults; then OPENAI_API_KEY with https://api.openai.com/v1; model defaults: router gpt-4o-mini, synth gpt-4o-mini, research gpt-4o, embeddings text-embedding-3-small, rerank = synth
export function getClient(role: Role): OpenAI;      // memoized per baseURL+key
export async function chatJSON<T>(role: Role, system: string, user: string, schema: z.ZodType<T>): Promise<T>; // response_format json_object when the backend supports it; always validates with zod and retries once with the validation error appended (graceful degradation for small/local models); falls back to `fallback` config on network/5xx
export async function chatText(role: Role, system: string, user: string): Promise<string>;
export async function embed(texts: string[]): Promise<number[][]>;  // embeddings role; dimension read from the first response and cached
```
Rewire `src/tools/libraryAsk.ts` and `src/pipeline/providers/openai.ts` to use it (no behavior change with only `OPENAI_API_KEY` set). Document in README how to point roles at LiteLLM (`ALEXANDRIA_BASE_URL=http://100.78.123.100:4001/v1`) or Cloudflare AI Gateway. Tests: config resolution precedence; `chatJSON` retry on invalid JSON using a fake OpenAI-compatible server. Commit `feat(providers): per-role OpenAI-compatible provider table with fallback (THE-318)`.

---

## Stage 8: Routing v2 and the routing gate

### Task 8.1: catalog embeddings, two-stage router, eval

**Files:** `src/tools/libraryAsk.ts` (rewrite the selection stage), `src/utils/catalogIndex.ts`, `scripts/eval-routing.ts`, `eval/routing-golden.yaml`, tests.

```ts
// catalogIndex.ts
export interface CatalogEntry { name: string; text: string; cluster: Cluster; freshness: Freshness; vector?: number[] }
export async function buildCatalog(): Promise<CatalogEntry[]>;                   // from catalog(); embeds `${name}: ${description} (cluster ${cluster})` when an embeddings role is configured; cached in memory for the process; persisted to eval/catalog-embeddings.json keyed by sha256 of the text so restarts skip re-embedding
export function bm25Candidates(query: string, entries: CatalogEntry[], k: number): CatalogEntry[]; // fallback when no embeddings: token overlap with cluster keyword boosts
export async function candidates(query: string, k: number, opts?: { freshness?: Freshness }): Promise<CatalogEntry[]>; // cosine top-k when vectors exist else bm25; always includes every entry of the top-scoring cluster up to k
```
`libraryAsk` stage 1: `candidates(query, 20)`; stage 2: the existing gpt-4o-mini selection prompt now receives only those 20 with cluster and freshness tags, picks `max_sources` (default 5), rewrites per-source queries; fan-out unchanged (allSettled over guarded adapters); results carry `cluster`. `SYSTEM_PROMPT` becomes a template with the source list generated, not hand-written. Recency intent (`latest`, `today`, `this week`, a year >= current-1) sets `freshness: 'realtime'|'daily'` preference in stage 1.

`eval/routing-golden.yaml`: at least 60 queries across all clusters, each with `expected: [source, ...]` (1 to 3) written by hand from the source descriptions (examples: "Case-Shiller home price index last 12 months" -> [fred, dbnomics]; "CVE-2026-1234 exploitation status" -> [circl, kev, epss]; "Hormuz shipping disruption this week" -> [gdelt, aljazeera, almonitor]; "Pride and Prejudice full text" -> [gutenberg, standardebooks]; "npm package left-pad maintainers" -> [ecosystems, depsdev]). `scripts/eval-routing.ts` runs stage 1 and stage 1+2 and reports nDCG@5 and recall@5 per cluster; `npm run eval:routing` exits 1 if nDCG@5 (stage 1) < 0.60 once embeddings are configured, else prints only. Record the first result in `docs/routing-eval.md`.

Commit `feat(routing): registry-generated catalog, embedding-first two-stage router, routing eval gate`.

---

## Stage 9: Answer and research layer

### Task 9.1: `fuse.ts` and `library_answer`

```ts
// fuse.ts
export function rrf(lists: LibraryResult[][], k = 60): Array<LibraryResult & { score: number }>; // reciprocal rank fusion on id+source, dedupe by normalized title
export async function llmRerank(query: string, items: LibraryResult[], top = 10): Promise<LibraryResult[]>; // listwise: synth role returns ordered ids as JSON; enabled by ALEXANDRIA_RERANK=llm; default off
```
`library_answer(query, max_sources?=6, results_per_source?=5, read_top?=4)`: run `libraryAsk` internals to get per-source lists; `rrf`; optional rerank; for the top `read_top` results with `hasFullText`, `read()` and take the first 6,000 chars each; if `KNOWLEDGE_MCP_URL` is set, also call its `knowledge_search` through the pool and fuse those hits as one more list; synthesize with the `synth` role using a prompt that requires every claim to end with `[n]` citing the numbered sources; return `{ answer, citations: [{ n, source, id, title, url }], results, routing }`. Validate that every `[n]` in the answer exists in citations; drop sentences with dangling citations rather than fail.

### Task 9.2: `library_research`

`library_research(query, depth?=2, breadth?=4, max_minutes?=6)`: loop from the Trigger.dev/AI SDK recursive shape: `generateQueries(query, learnings, breadth)` via `research` role -> for each, `library_answer` (with `read_top: 2`) -> `extractLearnings(answer)` returns `{ learnings: string[], followUps: string[] }` -> recurse with `breadth = ceil(breadth/2)` until depth 0, time budget, or no new sources -> final report via `research` role with sections and per-claim `[n]` citations from the union of all citations; a separate citation-check pass asks the `synth` role to list any claims without support and removes them. Emit MCP progress notifications per round (`server.sendLoggingMessage` or `notifications/progress` where the SDK allows). Per-round quota accounting goes through the guarded adapters automatically. Register both tools in `src/index.ts` (nine tools total).

Tests: fuse.rrf ordering and dedupe on synthetic lists; citation validation; research loop with a fake provider that returns canned JSON, asserting depth/breadth/time-budget stop conditions. Live smoke (needs a key): one `library_answer` on "what did the Zenodo API change in November 2025" returns an answer with at least two citations. Commit `feat(answer): library_answer and library_research with RRF fusion and citation checks (THE-317/319/320)`.

---

## Stage 10: Docs, version, release, weekly probe

### Task 10.1: generated docs and 10.0.0

- `scripts/gen-docs.ts` writes `docs/sources.md` (table: name, kind, cluster, freshness, auth env, verifiedAt, description) and rewrites the README source section between `<!-- sources:start -->` and `<!-- sources:end -->` markers, the count in the intro, the tool table (nine tools), and `.env.example` between markers listing every `auth.env` and feature env (`ALEXANDRIA_*`, `SEARXNG_URL`, `CRAWL4AI_URL`, `SUPADATA_API_KEY`, `KNOWLEDGE_MCP_URL`, `SUPABASE_*`).
- `src/index.ts`: version `10.0.0`; `/health` returns `{ status, sources, byKind, hidden }`.
- `CHANGELOG.md` entry for 10.0.0 summarizing stages.
- `.github/workflows/probe.yml`: `schedule: cron '0 6 * * 1'` and `workflow_dispatch`; runs `npm run probe`, uploads `eval/probe-latest.json`, and on exit 1 creates or updates an issue titled "Weekly probe regressions" with the regression list (use `actions/github-script`).
- Tag `v10.0.0` after merge; publish via the existing GitHub Packages workflow is the owner's call.

Commit `chore(release): 10.0.0, generated docs, weekly probe workflow`.

### Task 10.2: hand-off notes (no code)

Update Linear (THE-126, THE-130, THE-166, THE-311, THE-315, THE-317, THE-318, THE-319, THE-320: state and a comment linking the PRs) and the vault project note. Note the two deferred items: MCP SDK v2 migration; hosting decision (Cave/Coolify behind Cloudflare Access vs Railway plus tunneled gateway) and re-pointing Railway from the private repo to this one.

---

## Self-review

- Spec coverage: Stage 0 probe (round two), Stage 1 contract + THE-311 + THE-166 (plan review, assessment), Stage 2 repairs (round two tables), Stage 3 RSS (plan review), Stage 4 hubs and clusters (plan review tables), Stage 5 delegation (round two), Stage 6 web tier (plan review), Stage 7 THE-318, Stage 8 routing + eval (plan review), Stage 9 THE-317/319/320, Stage 10 docs/version/weekly probe. Not covered on purpose: SDK v2 migration, hosting move, Cloudflare Workers/Workflows/Vectorize, Supabase-to-LanceDB migration, THE-313 adjacency routing (post-ship), ACLED (no API access), Trove full text beyond the key-gated read.
- Placeholders: none; every adapter row names its request and mapping. Where an upstream is uncertain (congress search, eia search) the row gives the fallback to use.
- Type consistency: `SourceMeta`, `AuthSpec`, `Cluster`, `Freshness`, `SourceKind` defined in Task 1.1 and used unchanged by 4.0, 3.1, 5.1, 8.1. `LibraryResult` gains `published?` and `url?` in Task 1.1; `rrf` in 9.1 keys on `id+source`.
