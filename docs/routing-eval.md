# Routing eval

`npm run eval:routing` scores the two-stage router (`src/tools/libraryAsk.ts`,
`src/utils/catalogIndex.ts`) against the hand-written golden set at
`eval/routing-golden.yaml` (81 queries spanning all 19 registry clusters).
It reports nDCG@5 and recall@5 for stage 1 (`candidates()`) alone, per
cluster and overall, and for stage 1+2 (the router LLM's actual source
picks) whenever a `router` provider role is configured. The gate
(`process.exit(1)`) only fires when an embeddings role is configured and
stage-1 nDCG@5 is below 0.60; a BM25-only run always exits 0 and only
prints, since there's nothing to regress against yet.

Each golden query is grouped into a cluster (for the per-cluster table
only, not for scoring) by its *first* expected source's own registry
cluster. A query can legitimately land in a cluster other than the one its
prose suggests when its first expected source belongs elsewhere - e.g.
"Hormuz shipping disruption this week" expects `[gdelt, aljazeera,
almonitor]`, and `gdelt` is registered under `news_global`, not
`geopolitical`, so that row is counted there.

## 2026-09-02, BM25-only baseline

No `OPENAI_API_KEY` or `ALEXANDRIA_EMBEDDINGS_*` is set in this
environment, so `buildCatalog()` never embeds and stage 1 runs entirely
on the in-repo BM25 ranker (term frequency plus a cluster-keyword boost).
No router role is configured either, so stage 1+2 was skipped (it makes
one live LLM call per query and needs `OPENAI_API_KEY` or
`ALEXANDRIA_ROUTER_API_KEY`). These are the first-ever numbers for this
router; there is no prior baseline to compare against.

```
Stage 1 (BM25 fallback, no embeddings configured)
cluster             n   nDCG@5   recall@5
academic            5    0.188      0.300
ai_research         2    0.775      1.000
archives            3    0.333      0.333
culture             5    0.386      0.600
developer           7    0.310      0.500
economics           5    0.386      0.600
geopolitical        2    0.000      0.000
government          4    0.533      0.750
law                 3    0.544      0.667
literature          8    0.125      0.125
markets             2    0.500      0.500
news_global         4    0.250      0.250
news_regional       7    0.130      0.119
real_estate         2    0.000      0.000
science             6    0.420      0.667
security            8    0.133      0.250
standards           3    0.710      1.000
video               1    0.431      1.000
web                 4    0.311      0.375
OVERALL            81    0.303      0.424

Stage 1+2: skipped, no router role configured (set OPENAI_API_KEY or ALEXANDRIA_ROUTER_API_KEY)

stage1_ndcg_at_5=0.3034 embeddings_configured=false
```

Gate: not evaluated (`embeddings_configured=false`); exit code 0.

### Reading these numbers

BM25-only, overall nDCG@5 is 0.303 and recall@5 is 0.424, well under the
0.60 floor the gate would apply once embeddings are configured. This is
expected, not a regression to chase in this PR: BM25 has no semantic
understanding of a query like "USD to EUR exchange rate today" matching a
source described as "free daily exchange rates from the European Central
Bank" (`frankfurter`) when the token overlap is thin. Once
`OPENAI_API_KEY` or `ALEXANDRIA_EMBEDDINGS_*` is set on the real
deployment, `buildCatalog()` embeds every source description and
`candidates()` switches to cosine ranking, which should score
substantially higher; that run will be the one the 0.60 gate actually
applies to.

Two clusters (`geopolitical`, `real_estate`) score exactly 0.000: every
golden query in those clusters expects a source that is currently
`hidden` (needs an API key not set in this environment - `hapi`,
`reliefweb`, `ucdp`, `hud`, `rentcast`), so `catalog()` (the routing view
`candidates()` draws from) excludes them entirely and stage 1 can never
surface them here. That's a real, deployment-specific gap (missing keys),
not a ranking-algorithm gap; a deployment with those keys set would not
see this floor.

To re-run: `npm run eval:routing`. To re-run against embeddings, set
`OPENAI_API_KEY` (or `ALEXANDRIA_EMBEDDINGS_*`) first; the eval script
will pick up whichever embeddings config `src/utils/providers.ts`
resolves.
