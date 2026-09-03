# Routing eval

`npm run eval:routing` scores the two-stage router (`src/tools/libraryAsk.ts`,
`src/utils/catalogIndex.ts`) against the hand-written golden set at
`eval/routing-golden.yaml` (81 queries spanning all 19 registry clusters).
It reports nDCG@5, recall@5, and (stage 1 only) recall@20, per cluster and
overall, and for stage 1+2 (the router LLM's actual source picks) whenever
a `router` provider role is configured. The gate (`process.exit(1)`) only
fires when an embeddings role is configured and stage-1 nDCG@5 is below
0.60 or stage-1 recall@20 is below 0.80 (stage 2 only ever sees stage 1's
top 20 candidates, so recall@20 is the real ceiling on what stage 2 could
possibly recover); a BM25-only run always exits 0 and only prints, since
there's nothing to regress against yet.

Each golden query is grouped into a cluster (for the per-cluster table
only, not for scoring) by its *first* expected source's own registry
cluster. A query can legitimately land in a cluster other than the one its
prose suggests when its first expected source belongs elsewhere - e.g.
"Hormuz shipping disruption this week" expects `[gdelt, aljazeera,
almonitor]`, and `gdelt` is registered under `news_global`, not
`geopolitical`, so that row is counted there.

**Fairness**: a golden query's `expected` list can legitimately name a
source that's currently `hidden` (needs an API key not set in this
deployment). Scoring that source as a miss would penalize the router for a
key this deployment doesn't have, not for a routing mistake, so `score()`
drops hidden expected sources before scoring (`listSources()` is the
source of truth for what's hidden right now), counts how many it dropped
(`skipped hidden expected: N`), and excludes a query entirely, rather than
scoring it against an empty expected set, when every one of its expected
sources turns out hidden (`skipped queries: M`). Both counts print per
cluster and overall.

## 2026-09-02, BM25-only baseline

No `OPENAI_API_KEY` or `ALEXANDRIA_EMBEDDINGS_*` is set in this
environment, so `buildCatalog()` never embeds and stage 1 runs entirely
on the in-repo BM25 ranker (term frequency plus a cluster-keyword boost).
No router role is configured either, so stage 1+2 was skipped (it makes
one live LLM call per query and needs `OPENAI_API_KEY` or
`ALEXANDRIA_ROUTER_API_KEY`). This replaces the first BM25-only run
recorded here: that run predated two fixes from PR review - see "What
changed since the first run" below - so its numbers are not comparable and
are not reproduced here.

```
Stage 1 (BM25 fallback, no embeddings configured)
cluster             n   nDCG@5   recall@5   recall@20
academic            5    0.649      0.700       1.000
                 skipped hidden expected: 0, skipped queries: 0
ai_research         2    0.960      1.000       1.000
                 skipped hidden expected: 0, skipped queries: 0
archives            1    1.000      1.000       1.000
                 skipped hidden expected: 2, skipped queries: 2
culture             4    1.000      1.000       1.000
                 skipped hidden expected: 1, skipped queries: 1
developer           7    0.831      1.000       1.000
                 skipped hidden expected: 1, skipped queries: 0
economics           5    0.800      0.800       0.800
                 skipped hidden expected: 1, skipped queries: 0
geopolitical        0    0.000      0.000       0.000
                 skipped hidden expected: 3, skipped queries: 2
government          3    1.000      1.000       1.000
                 skipped hidden expected: 1, skipped queries: 1
law                 2    1.000      1.000       1.000
                 skipped hidden expected: 1, skipped queries: 1
literature          7    0.793      0.857       0.857
                 skipped hidden expected: 1, skipped queries: 1
markets             1    1.000      1.000       1.000
                 skipped hidden expected: 1, skipped queries: 1
news_global         2    0.500      0.500       0.500
                 skipped hidden expected: 2, skipped queries: 2
news_regional       7    0.977      1.000       1.000
                 skipped hidden expected: 0, skipped queries: 0
real_estate         0    0.000      0.000       0.000
                 skipped hidden expected: 2, skipped queries: 2
science             6    1.000      1.000       1.000
                 skipped hidden expected: 0, skipped queries: 0
security            8    0.948      0.958       1.000
                 skipped hidden expected: 0, skipped queries: 0
standards           3    1.000      1.000       1.000
                 skipped hidden expected: 0, skipped queries: 0
video               1    0.431      1.000       1.000
                 skipped hidden expected: 0, skipped queries: 0
web                 2    1.000      1.000       1.000
                 skipped hidden expected: 3, skipped queries: 2
OVERALL            66    0.885      0.927       0.955
                 skipped hidden expected: 19, skipped queries: 15

Stage 1+2: skipped, no router role configured (set OPENAI_API_KEY or ALEXANDRIA_ROUTER_API_KEY)

stage1_ndcg_at_5=0.8846 stage1_recall_at_20=0.9545 embeddings_configured=false
```

Gate: not evaluated (`embeddings_configured=false`); exit code 0.

### What changed since the first run

Two bugs fixed in PR review moved these numbers from a 0.303 nDCG@5 /
0.424 recall@5 baseline to 0.885 / 0.927 (and 0.955 recall@20), on the
same golden set and the same BM25-only environment:

1. **Ranking-order bug**: `withClusterFloor()` in `src/utils/catalogIndex.ts`
   filled the top-scoring cluster's slots by iterating the raw catalog
   (source-registration/file order) instead of the already-ranked (score
   order) list, so within the dominant cluster the top-5 was silently
   reordered by wherever each source happened to be registered rather than
   by its actual BM25 score - e.g. for "npm package left-pad maintainers",
   `depsdev` scored #1 in raw BM25 but came back #3, behind `codewiki` and
   `lobsters`, purely because of source file order.
2. **Eval fairness**: 15 of the 81 golden queries had every one of their
   expected sources currently `hidden` (needs an API key not set in this
   environment - the whole `geopolitical` and `real_estate` clusters, plus
   scattered entries elsewhere), and a further several queries had one
   hidden source alongside a visible one. Scoring those as flat misses
   measured missing API keys, not routing quality; `score()` now drops
   hidden expected sources and excludes a fully-hidden query from the
   averages instead (see "Fairness" above).

### Reading these numbers

BM25-only, overall nDCG@5 is 0.885, recall@5 is 0.927, and recall@20 is
0.955 - now comfortably above the 0.60/0.80 floors the gate would apply
once embeddings are configured, on a purely lexical ranker with no
semantic understanding. That's a reasonable BM25 ceiling for a hand-written
golden set whose queries mostly echo real source-description vocabulary;
it isn't a substitute for the real, embeddings-configured run once a key
is available, which is the run the gate actually applies to.

`geopolitical` and `real_estate` show `n=0`: every golden query in each of
those clusters expects a source that is currently `hidden` (needs an API
key not set here - `hapi`, `reliefweb`, `ucdp`, `hud`, `rentcast`), so
every one of their queries is excluded entirely (`skipped queries`) rather
than scored. That's a real, deployment-specific gap (missing keys), not a
ranking-algorithm gap; a deployment with those keys set would score those
clusters instead of skipping them.

To re-run: `npm run eval:routing`. To re-run against embeddings, set
`OPENAI_API_KEY` (or `ALEXANDRIA_EMBEDDINGS_*`) first; the eval script
will pick up whichever embeddings config `src/utils/providers.ts`
resolves.

## 2026-09-02, Task 6: router-skip margin

Eight `npm run eval:routing` runs against the Cave LiteLLM gateway,
measuring the stage-1 confidence margin (`src/utils/catalogIndex.ts`'s
`candidatesWithMargin()`) that lets `library_ask` skip the router LLM call
entirely (`src/tools/libraryAsk.ts`'s `planRoute()`), plus the routing
decision cache. `eval/routing-golden.yaml` had 62 non-fully-hidden queries
at run time (66 on 2026-09-02's earlier BM25-only baseline above; the
`hidden` source set drifted between the two runs - see the "Fairness"
section above for why a fully-hidden query is excluded rather than scored).

**Models**: router role `openai/gpt-4o-mini` (via the gateway, with
`ALEXANDRIA_ROUTER_JSON_MODE=1` - the gateway's own hostname isn't
`api.openai.com`, so `chatJSON` won't request `response_format:
json_object` on its own, and two other models tried first without it,
`deepinfra/google/gemini-2.5-flash` and `anthropic/claude-haiku-4-5`,
returned unparseable JSON - a `<think>` preamble on the first, markdown
code fences on the second, neither stripped by `chatJSON`'s current
parser). Embeddings role `BAAI/bge-m3` (1024 dims, confirmed via
`embeddingDimensions()` during the run).

**Env var correction**: the task brief named `ALEXANDRIA_EMBED_BASE_URL` /
`ALEXANDRIA_EMBED_API_KEY` / `ALEXANDRIA_EMBED_MODEL`. `src/utils/
providers.ts`'s `envKey()` (via `config.ts`'s `roleFields('EMBEDDINGS',
...)`) reads `ALEXANDRIA_EMBEDDINGS_BASE_URL` / `_API_KEY` / `_MODEL`
(role name `EMBEDDINGS`, not `EMBED`) - used the names the code actually
reads.

**Credential handling**: `LITELLM_AGENT_KEY` was read from
`/data/llm-stack/.env` with `grep '^LITELLM_AGENT_KEY=' | cut -d= -f2-`
into a shell variable, not sourced wholesale - an earlier attempt that did
`set -a; . /data/llm-stack/.env; set +a` leaked that file's own
`OPENAI_API_KEY` into the process environment, which made
`hasEmbeddingsConfigured()` silently true (via `roleConfig()`'s
`openaiApiKey` fallback) during what was meant to be the BM25-only run,
against real `api.openai.com` with a different model - caught by the
`library_ask_llm_calls_avg=2.000` in that first, discarded attempt (BM25
mode should cost 1 call, not 2) and re-run correctly. Every eval
invocation below also explicitly `env -u`s `OPENAI_API_KEY`,
`ALEXANDRIA_API_KEY`, and `ALEXANDRIA_BASE_URL` as a second guard. The key
value itself is never in this file, a log, or a commit - only the
variable name.

**Gateway host gotcha**: pointing `ALEXANDRIA_EMBEDDINGS_BASE_URL` at the
gateway's literal IP (`http://100.78.123.100:4001/v1`, as CLAUDE.md
documents it) made every embed call through `installDispatcher()`'s
globally-installed DNS-caching dispatcher (`src/utils/dispatcher.ts`) hang
past its 15s headers timeout, even though a plain `curl` to the same IP
returned in under 2s and a raw `fetch()` with no dispatcher installed
worked immediately - consistent with undici's DNS interceptor attempting
an actual resolver lookup on an IP literal instead of recognizing it needs
none. Using the box's Tailscale MagicDNS name for the same host
(`http://cave.tail3f4c45.ts.net:4001/v1`, found via `tailscale status` /
`getent hosts`) avoided it. `scripts/eval-routing.ts` calls
`installDispatcher()` unconditionally (pre-existing, Task 3), so this
matters for anyone re-running this eval against that gateway by IP; it is
not a Task 6 change and is not fixed here - `src/utils/dispatcher.ts` is
out of this task's file list. Flagged as a concern in the task report.

**Catalog cache isolation**: `buildCatalog()`'s disk cache
(`ALEXANDRIA_CATALOG_CACHE`) keys each entry by `sha256(entryText)` only,
not by embedding model - a model change reusing the default
`eval/catalog-embeddings.json` would silently serve vectors from whatever
model built it. No such file existed yet in this repo, but every
embeddings run below pointed `ALEXANDRIA_CATALOG_CACHE` at a
model-specific path, `eval/catalog-embeddings-bge-m3.json`, to keep it
that way going forward. That per-text (not per-model) cache key is a
pre-existing design choice (Task 3), not changed here.

**Method**: each of the 8 runs is a separate process with
`ALEXANDRIA_STATE_DB=:memory:`, so the Task 6 routing cache starts empty
every time and one run's cached decisions can never leak into another's
numbers. `ALEXANDRIA_ROUTER_SKIP_MARGIN=1000` stands in for "never skip"
on the two "with the LLM router" rows (`parseSkipMargin`'s upper bound was
deliberately left open for exactly this - see its comment in
`libraryAsk.ts`) rather than leaving the var unset, which would apply
whatever `DEFAULT_ROUTER_SKIP_MARGIN` this change ships.

| stage-1 mode | router mode | stage-1 nDCG@5 | stage-1+2 nDCG@5 | stage-1+2 recall@5 | LLM calls / `library_ask` | stage2 llm / skipped |
|---|---|---|---|---|---|---|
| BM25 | always router | 0.8882 | 0.896 | 0.903 | 1.000 | 62 / 0 |
| BM25 | skip @ 0.2 | 0.8882 | 0.872 | 0.906 | 0.032 | 2 / 60 |
| BM25 | skip @ 0.3 | 0.8882 | 0.872 | 0.906 | 0.032 | 2 / 60 |
| BM25 | skip @ 0.4 | 0.8882 | 0.872 | 0.906 | 0.032 | 2 / 60 |
| embeddings (bge-m3) | always router | 0.9101 | 0.937 | 0.946 | 2.000 | 62 / 0 |
| embeddings (bge-m3) | skip @ 0.2 | 0.9101 | 0.925 | 0.938 | 1.274 | 17 / 45 |
| embeddings (bge-m3) | skip @ 0.3 | 0.9101 | 0.937 | 0.944 | 1.597 | 37 / 25 |
| embeddings (bge-m3) | skip @ 0.4 | 0.9101 | 0.944 | 0.960 | 1.935 | 58 / 4 |

`stage1_recall_at_20` was 0.9516 (BM25) and 0.9785 (embeddings) in every
row of its own mode, unaffected by the router/skip setting (recall@20 is
a stage-1-only metric); both are well above the 0.80 gate floor, and both
stage-1 nDCG@5 numbers clear the 0.60 floor, so `npm run eval:routing`
exited 0 in every one of the 8 runs (the gate only ever fires below those
floors).

All three BM25 skip margins land on the identical 2 LLM / 60 skipped
split: this golden set's BM25 margin distribution is bimodal for this
catalog - a query either has one term-dominant source (margin well above
0.4) or several similarly-scored candidates (margin well below 0.2) - so
0.2/0.3/0.4 draw the same line through it. Embeddings' cosine margins are
smoother, so the three thresholds there do move the split meaningfully
(45/25/4 skipped).

### Choosing the default `routerSkipMargin`

Per the brief: the largest tested margin whose stage-1+2 nDCG@5 is within
0.01 of the "always call the router" number, on the better of the two
stage-1 modes.

1. **Better stage-1 mode**: embeddings, nDCG@5 0.9101 vs BM25's 0.8882
   (`0.9101 > 0.8882`, checked with `calc`).
2. **Target**: embeddings' always-router stage-1+2 nDCG@5, 0.937.
3. **Within 0.01, largest margin wins** (`calc cmp`, exact):
   - margin 0.2: `|0.937 - 0.925| = 0.012` - **not** within 0.01.
   - margin 0.3: `|0.937 - 0.937| = 0` - within 0.01.
   - margin 0.4: `|0.937 - 0.944| = 0.007` - within 0.01 (and, on this
     golden set, margin 0.4 actually scored a touch *above* the
     always-router baseline - noise at n=62, not a claim that skipping
     improves routing quality).
4. **Default: `routerSkipMargin = 0.4`** - the largest of the three that
   qualifies. At that margin, 58 of 62 golden queries (94%) still route
   through the LLM; only the 4 most stage-1-dominant queries skip it. The
   LLM-call savings scale with how often real traffic looks like those 4
   (a single obviously-dominant source) rather than the golden set's
   overall skip rate at that margin, since the golden set is
   deliberately weighted toward genuinely ambiguous queries.

`DEFAULT_ROUTER_SKIP_MARGIN` in `src/tools/libraryAsk.ts` is set to `0.4`;
override per deployment with `ALEXANDRIA_ROUTER_SKIP_MARGIN`.

### Routing cache

Independent of the margin: `planRoute()` caches the full routing decision
(intent, routes, and which path produced it) by normalised query +
`max_sources`, through the Task 4 `stateStore`, for `config.
ALEXANDRIA_CACHE_TTL_MS` (the same TTL `searchCache` uses - `src/utils/
resultCache.ts`'s `routingCache`). A cache hit skips stage 1 *and* stage
2 entirely: no router call and no query embed. This isn't exercised by
`eval:routing` (each golden query runs once, so nothing repeats within a
run - each of the 8 runs here uses a fresh `:memory:` store precisely so
routing decisions don't leak between runs); it's covered by `src/tools/
libraryAsk.test.ts`'s "router skip margin and routing cache" tests
instead, which count calls on a fake router server directly.

To re-run this eval: point `ALEXANDRIA_ROUTER_*` and (for the embeddings
rows) `ALEXANDRIA_EMBEDDINGS_*` at a real provider, set
`ALEXANDRIA_ROUTER_SKIP_MARGIN` to the margin under test (or leave it
unset for the shipped default, or set it above 1 for "always route"), and
run `npm run eval:routing`.
