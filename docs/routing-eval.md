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
