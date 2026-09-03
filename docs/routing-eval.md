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

**Gateway host gotcha (did not reproduce, final wave)**: an earlier run of
this eval saw every embed call against the gateway's literal IP
(`http://100.78.123.100:4001/v1`, as CLAUDE.md documents it) hang past its
15s headers timeout through `installDispatcher()`'s globally-installed
dispatcher (`src/utils/dispatcher.ts`), and switching to the box's
Tailscale MagicDNS name for the same host
(`http://cave.tail3f4c45.ts.net:4001/v1`) avoided it. That was read at the
time as undici's DNS interceptor mishandling an IP literal. The final-wave
review ran the exact production dispatcher shape against
`http://100.78.123.100:4001` and 18 other literal-IP hosts over GET, POST,
and SSE: all 200, 5-87ms, no hang. The original cause was never isolated;
the MagicDNS name was a workaround that happened to sidestep whatever the
real cause was (network path, gateway-side, or transient), not a fix for
a bug in this codebase. Do not code against the hang - there is nothing in
`src/utils/dispatcher.ts` shown to reproduce it.

**Catalog cache isolation**: `buildCatalog()`'s disk cache
(`ALEXANDRIA_CATALOG_CACHE`) now keys each entry by
`sha256(embeddingsModel + '\0' + entryText)` (final wave, A1), so a model
change can never reuse another model's vectors under the same default
`eval/catalog-embeddings.json` path. Every embeddings run below still
pointed `ALEXANDRIA_CATALOG_CACHE` at its own path,
`eval/catalog-embeddings-bge-m3.json`, which remains harmless belt and
braces now that the key itself carries the model.

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

### The default only applies in embeddings mode

Fix round 1 (review verdict, controller ruling): the default
`routerSkipMargin` above was chosen entirely from the **embeddings** rows.
The **BM25-only** rows tell a different story - at every one of the three
tested margins (0.2, 0.3, 0.4), BM25-only stage-1+2 nDCG@5 was **0.872**
against an always-router baseline of **0.896**, a 0.024 regression
outside the brief's 0.01 tolerance band, and all three margins skipped
the identical 60 of 62 queries (BM25's normalised margin is
near-saturated: an unbounded, purely-additive score means the gap between
the top candidate and the one at `max_sources+1` is very often close to
the full top score, so nearly every query clears 0.2, 0.3, *and* 0.4
alike - see the "All three BM25 skip margins land on the identical..."
paragraph above). A deployment with a router key but no embeddings key
would otherwise inherit that regression silently, since
`ALEXANDRIA_ROUTER_SKIP_MARGIN` unset applies the same default margin
regardless of which ranker produced it.

**Rule** (`src/tools/libraryAsk.ts`'s `planRoute()`): the default skip
margin applies only when stage 1 ran in embedding mode
(`candidatesWithMargin()`'s `stage1: 'embeddings'`, i.e. `buildCatalog()`
had every entry embedded). In BM25 mode
(`stage1: 'bm25'`), `parseSkipMargin` is called with a fallback of
`+Infinity` instead of `DEFAULT_ROUTER_SKIP_MARGIN`, so an unset or
invalid `ALEXANDRIA_ROUTER_SKIP_MARGIN` never skips there - the margin,
always finite, can never reach it. An operator who sets
`ALEXANDRIA_ROUTER_SKIP_MARGIN` explicitly and validly is opting in
deliberately, and that value is honoured in either mode exactly the same
way, per the brief: "an explicit value is an opt-in and applies in both
modes." The routing result now carries `stage1: 'embeddings' | 'bm25'`
alongside `stage2` so a caller (and `/metrics`) can see which ranker
produced a given decision.

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

## 2026-09-03, Task 10: margin-gated multi-query

`ALEXANDRIA_MULTI_QUERY=1` (off by default): whenever stage 1's margin is
below the router-skip margin (i.e. stage 2 is about to make an LLM call
anyway - `src/tools/libraryAsk.ts`'s `planRoute()`), the router role is
asked for two alternate phrasings of the query, stage 1
(`candidates()`) reruns for each, and the three shortlists (original plus
two alternates) are unioned by catalog entry name before stage 2 sees
them. Two runs against the same golden set, same gateway/models as the
Task 6/8 rows above (`http://cave.tail3f4c45.ts.net:4001/v1` - the
Tailscale MagicDNS name for the same host CLAUDE.md documents as
`100.78.123.100`, since the literal-IP form hung on the embed call this
run, reproducing the "Gateway host gotcha" noted above; `ALEXANDRIA_API_KEY`
read from `/data/llm-stack/.env`'s `LITELLM_AGENT_KEY` via `grep | cut`,
never echoed/logged/committed; `ALEXANDRIA_EMBEDDINGS_MODEL=BAAI/bge-m3`,
`ALEXANDRIA_ROUTER_MODEL=ALEXANDRIA_SYNTH_MODEL=openai/gpt-4o-mini`, both
`_JSON_MODE=1`), default `ALEXANDRIA_ROUTER_SKIP_MARGIN` (0.4, embeddings
mode), `ALEXANDRIA_STATE_DB=:memory:`:

| Multi-query | Stage 1+2 nDCG@5 | Stage 1+2 recall@5 | LLM calls (total / avg per query) |
|---|---|---|---|
| off | 0.944 | 0.967 | 147 / 1.934 |
| on (`ALEXANDRIA_MULTI_QUERY=1`) | 0.951 | 0.980 | 360 / 4.737 |

Both runs scored the identical 76 of 96 golden queries (20 excluded, same
as every row above, for having every `expected` source hidden), and stage
1's own numbers (nDCG@5 0.9021, recall@20 0.9956) are unchanged between
the two rows by construction - multi-query only widens what stage 2 sees
when it was already going to run (`stage2_llm=71` of 76 in both runs; the
5 that skip the router at this margin never reach the multi-query branch
at all). +0.007 nDCG@5 and +0.013 recall@5 on this golden set, at 2.45x
the LLM call volume (360/147, exact via `calc`) - each of the 71
stage2-llm queries costs one extra router call (the alternate-phrasings
request) plus two extra embed calls (one per alternate query's stage-1
rerun), on top of the one routing-decision call and one stage-1 embed
call every query already made. Whether that trade is worth it in
production depends on how much a deployment values the last ~1-3 points
of routing quality against roughly 2.5x the router-role token spend on
already-ambiguous queries (the margin gate means confident queries never
pay this cost at all); it ships default-off pending a decision from
whoever operates the deployment, per the brief.

To re-run: same env as above, `ALEXANDRIA_MULTI_QUERY=1` for the "on"
row, unset (or `0`) for "off".
