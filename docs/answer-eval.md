# Answer/citation eval

`npm run eval:answer` scores `library_answer` (`src/tools/libraryAnswer.ts`)
against the hand-written golden set at `eval/answer-golden.yaml` (20
questions spanning 16 of the registry's clusters, each with 3-6
`expected_nuggets` - short, independently checkable factual statements -
and `expected_sources`, used only to group the per-cluster table, the same
role `expected` plays in `eval/routing-golden.yaml`). It needs both a
`synth` and an `embeddings` role configured (`library_answer` itself
requires `synth`; `embeddings` materially improves the routing that feeds
it); like `eval:routing`, it prints a message and exits 0 when either is
missing, rather than failing on a key this deployment simply doesn't have.

Three metrics, per question and averaged overall and per cluster:

- **citation precision** - of the answer's sentences that carry a citation
  marker, what fraction are actually *warranted* by the text of their
  cited source(s) - not just on-topic, but the same strength, scope, and
  time (the warrant-strength rubric from `research/retrieval-sota.md`
  section 4)? Judged with one `chatJSON` call per cited sentence, via a
  role read from the `CLAIM_SUPPORT_ROLE` constant in `scripts/
  eval-answer.ts` (today: `synth`; Task 9 adds a dedicated `verify` role,
  and that constant is the one line that needs to change). A sentence
  whose cited source couldn't be re-read at all is excluded from the
  denominator (nothing to judge it against), not counted as unwarranted.
- **nugget recall** (the brief's "citation recall" and "answer nugget
  recall" are the same computation under two names - see the module
  comment in `scripts/eval-answer.ts`) - of the golden question's
  `expected_nuggets`, how many are covered by at least one of the answer's
  *cited* sentences? Uncited prose doesn't count. Judged the same
  warrant-strength way, with the nugget as the claim and the joined cited
  sentences as the evidence.
- **resolvability** - of the citations that carry a URL, or an `id` shaped
  like a DOI, what fraction return a 2xx on a guarded HEAD (falling back
  to GET) through `src/web/fetchTier.ts`'s `assertFetchableUrl`, with a 5s
  timeout? Capped at 20 checks per question. A question with no
  URL/DOI-bearing citations at all contributes nothing to this average
  (see "resolvability is undefined, not zero" below) rather than a
  misleading 0.

**Exit code**: unlike `eval:routing`, this never fails on the scores
themselves - this run *is* the first baseline, so there's no floor yet to
regress against. `--gate` instead fails (exit 1) only on an infrastructure
problem: the required roles missing, or a golden question's `library_answer`
call throwing outright - so a CI environment that expects this eval to
actually run can catch "it silently no-op'd" or "it crashed", without
asserting a numeric floor nobody has earned yet. Plain `npm run eval:answer`
always exits 0. To be explicit: **`--gate` has no score floor yet** - it
does not fail on a low citation precision, nugget recall, or resolvability
number, only on the infrastructure problems above; a numeric floor is a
follow-up once enough baseline runs exist to set one responsibly (the same
way `eval:routing`'s 0.60/0.80 floors were set from an established run, not
invented up front).

## 2026-09-03, first baseline (Cave LiteLLM gateway)

**Models**: `synth` role `openai/gpt-4o-mini` and `router` role
`openai/gpt-4o-mini` (both via the gateway, with `ALEXANDRIA_SYNTH_JSON_MODE=1`
/ `ALEXANDRIA_ROUTER_JSON_MODE=1` - the gateway's hostname isn't
`api.openai.com`, so `chatJSON` won't request `response_format:
json_object` on its own). `embeddings` role `BAAI/bge-m3`. The task brief
named only `ALEXANDRIA_SYNTH_MODEL` for this run; `ALEXANDRIA_ROUTER_MODEL`
was set the same way for the same reason docs/routing-eval.md's Task 6 run
set it - `library_answer` calls `runAsk()` -> `planRoute()` internally, so
this eval exercises the router role too, and its unset default
(`gpt-4o-mini`, no provider prefix) isn't a route this gateway recognizes.

**Credential handling**: `LITELLM_AGENT_KEY` was read from
`/data/llm-stack/.env` with `grep '^LITELLM_AGENT_KEY=' | cut -d= -f2-`
into a shell variable, passed only as `ALEXANDRIA_API_KEY` to the eval
process, and never echoed, logged, or committed - only the variable name
appears here. `OPENAI_API_KEY` was explicitly unset (`env -u`) for the run
so no local key could shadow the intended gateway credential.

**Method**: `ALEXANDRIA_STATE_DB=:memory:` (a fresh store; no routing cache
carries over from any prior run). Two full runs were made against the
golden set; the second (below) is the one recorded, since the mean()
fix described under "resolvability is undefined, not zero" landed between
the two.

```
"When was the Transformer architecture introduced and what problem does self-attention solve?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.
"What is a Python Enhancement Proposal (PEP) and what do PEP 8 and PEP 484 cover?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.

Answer/citation eval
cluster             n  precision  nugget_recall  resolvability
academic            1      1.000          1.000            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 1
archives            1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
culture             1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
developer           0        NaN            NaN            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 0
economics           2      0.000          0.125            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 2
government          1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
law                 1      0.500          0.250            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 1
literature          2      0.250          0.375            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 2
markets             1      1.000          0.500            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 1
news_global         1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
real_estate         1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
science             1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
security            1        NaN          0.000            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 1
standards           2      1.000          0.125            NaN
                 skipped precision (no judgeable citation): 1, skipped resolvability (no url/DOI): 2
video               1      1.000          0.250            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 1
web                 1      0.000          0.250            NaN
                 skipped precision (no judgeable citation): 0, skipped resolvability (no url/DOI): 1
OVERALL            18      0.556          0.194            NaN
                 skipped precision (no judgeable citation): 9, skipped resolvability (no url/DOI): 18

citation_precision=0.5556 nugget_recall=0.1944 resolvability=NaN roles_configured=true
```

`developer` shows `n=0`: both of its golden questions (the JWT/RFC 7519
question and the PEP question) hit the timeout below rather than
completing - `academic`'s `1` (of 1) reflects the AlphaFold question
completing while the Transformer question in the same cluster timed out.

### Two questions timed out

Two of the 20 golden questions failed outright with `Request timed out.
Node.js fetch timed out waiting for response headers; configure a matching
undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout
is at least the SDK timeout` - an error surfaced by the `openai` SDK's own
request path, not this script. A first run (discarded, made before the
mean() fix below) saw three timeouts, overlapping on two of these same
questions plus a third; neither run reproduced a *consistent* failing
question, and `src/utils/dispatcher.ts` has no known reproducible hang (see
docs/routing-eval.md's "Gateway host gotcha (did not reproduce, final
wave)" section, which investigated the same failure shape against the same
gateway and found nothing to fix in this codebase). Treated the same way
here: not chased as a bug in this task, since the harness's own job -
catching the per-question exception, logging it, and continuing to score
the other 18 - worked exactly as intended (`scripts/eval-answer.ts`'s
`main()` loop). A CI run with `--gate` would fail on this (2 of 20 golden
questions didn't run), which is the intended signal for "the harness didn't
actually complete," independent of the scores.

### Resolvability is undefined, not zero

Every one of the 18 completed questions shows `resolvability: NaN` -
`skipped resolvability (no url/DOI): 18` out of 18. This is not a 0% pass
rate; it means none of the citations in this run carried a URL or a
DOI-shaped `id` to check at all. Confirmed directly:

```
$ node -e '... libraryAnswer("What is Bitcoin and who is credited with creating it?") ...'
[{ "n": 1, "source": "coingecko", "id": "bitcoin", "title": "Bitcoin (BTC)" }]
```

No `url` field. `buildCitations()` in `src/tools/libraryAnswer.ts` maps
`url: s.item.url` - `LibraryResult.url`, not `LibraryResult.previewUrl`.
Across `src/sources/*.ts`, 40 adapters set `url:` on their normalized
result and 85 set `previewUrl:` instead (`grep -rl '^\s*url:' src/sources/
*.ts | wc -l` vs the `previewUrl:` equivalent); every source this golden
set's questions actually cite in these two runs - `coingecko`, `wikipedia`,
`arxiv`, `ietf`, `gutenberg`, `guardian`, and others reached via
`hasFullText: true` sources - is in the `previewUrl`-only group. Separately,
none of the `id` values seen (`bitcoin`, arXiv ids, Wikipedia page titles,
RFC numbers, ...) are DOI-shaped, and the sources whose `id` *is* a DOI
(`crossref`, `datacite`, `opencitations`, ...) are metadata-only
(`hasFullText: false`), so `readTopSources()` never selects them to be read
and cited by `library_answer` in the first place. This is a real,
reportable structural gap in the current `Citation` shape, not a bug in
this eval script: resolvability, as specified, has almost no citations to
measure against until `Citation.url` is populated more broadly or Task 9's
`Citation.resolves` wiring (`task-9-brief.md` item 2, `liveness.ts`) lands.
`scripts/eval-answer.ts`'s `mean()` reports `NaN` rather than `0` for this
exact reason - an empty judged set must not read as "0% resolved" - so a
future run that fixes this gap will show a real number here, not a
false-zero silently improving.

### Reading the other two numbers

**Citation precision, 0.5556 overall** (10 judged sentences across 9
questions with at least one judgeable citation; 9 of 18 completed
questions had none - `skipped precision (no judgeable citation): 9`) - a
small-`n`, one-model number from the very first run of this harness, not a
number to alarm on. It's the number Task 9's warrant-strength `verify`
role work (task-9-brief.md item 1, `claimCheck.ts`) will be measured
against before/after.

**Nugget recall, 0.1944 overall** - low, and worth reading carefully
before treating it as an answer-quality problem: `library_answer`'s
`readTop` defaults to 4 sources, `maxSources` to 6, so a synthesized answer
realistically covers a handful of an expected nugget's angles, not every
one of the golden set's 3-6 independently-checkable facts per question.
Nugget recall only credits a nugget covered by a *cited* sentence - an
answer that states a fact from general knowledge without a source number
attached to it (this run had several) scores that nugget as not covered,
which is the intended, stricter reading of "citation recall" the brief
specifies (see the module comment in `scripts/eval-answer.ts`), not a
looser "did the answer mention this" recall.

### To re-run

```
ALEXANDRIA_BASE_URL=http://<gateway>/v1 \
ALEXANDRIA_API_KEY=<key> \
ALEXANDRIA_EMBEDDINGS_MODEL=BAAI/bge-m3 \
ALEXANDRIA_SYNTH_MODEL=<a chat model your gateway serves> \
ALEXANDRIA_SYNTH_JSON_MODE=1 \
ALEXANDRIA_ROUTER_MODEL=<the same chat model> \
ALEXANDRIA_ROUTER_JSON_MODE=1 \
npm run eval:answer
```

Without any roles configured, `npm run eval:answer` prints a short message
and exits 0 (or 1 with `--gate`) instead of making any network calls.

## 2026-09-03, Task 9: claim verification, citation liveness, and grades

Task 9 (`src/utils/claimCheck.ts`, `src/utils/liveness.ts`,
`src/utils/citationGrade.ts`) added a dedicated `verify` role for the
citation-precision judgment above (`CLAIM_SUPPORT_ROLE` in
`scripts/eval-answer.ts` flipped from `synth` to `verify` - `verify` falls
back to `synth`'s own config when `ALEXANDRIA_VERIFY_*` is unset, so this
run used the same model as before), fixed `buildCitations()` in
`src/tools/libraryAnswer.ts` to fall back through `previewUrl` then
`downloadUrl` when a source has no `url` (the structural gap the first
baseline above found), and wired `Citation.resolves` through the new
`src/utils/liveness.ts` (`checkLiveness`, moved out of
`scripts/eval-answer.ts`'s own `checkResolvable`, which now just calls it).

**Before**: the 2026-09-03 first-baseline run above -
`citation_precision=0.5556 nugget_recall=0.1944 resolvability=NaN` (18 of
20 questions completed; `Citation.url` populated by 40 of 125 adapters,
`Citation.resolves` didn't exist yet).

**After** (same gateway, same models, `ALEXANDRIA_STATE_DB=:memory:`,
`OPENAI_API_KEY` unset so no local key could shadow the gateway
credential; `LITELLM_AGENT_KEY` read from `/data/llm-stack/.env` via
`grep '^LITELLM_AGENT_KEY=' | cut -d= -f2-` into a shell variable, passed
only as `ALEXANDRIA_API_KEY`, never echoed/logged/committed):

```
"When was the Transformer architecture introduced and what problem does self-attention solve?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.
"What does AlphaFold do and what did it achieve at CASP14?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.
"What is a Python Enhancement Proposal (PEP) and what do PEP 8 and PEP 484 cover?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.
"What does the Case-Shiller home price index measure and who developed it?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.
"What is the FRED economic database and who maintains it?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.
"What is the Federal Register and what kinds of documents does it publish?" failed: Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.

Answer/citation eval
cluster             n  precision  nugget_recall  resolvability
academic            0        NaN            NaN            NaN
archives            1        NaN          0.000            NaN
culture             1        NaN          0.000            NaN
developer           0        NaN            NaN            NaN
economics           0        NaN            NaN            NaN
government          0        NaN            NaN            NaN
law                 1        NaN          0.000            NaN
literature          2      0.000          0.250          1.000
markets             1      1.000          0.500            NaN
news_global         1        NaN          0.000            NaN
real_estate         1      1.000          0.000          1.000
science             1      0.500          0.750          1.000
security            1        NaN          0.000            NaN
standards           2      0.000          0.000          1.000
video               1      1.000          0.500          1.000
web                 1        NaN          0.000            NaN
OVERALL            14      0.583          0.161          1.000

citation_precision=0.5833 nugget_recall=0.1607 resolvability=1.0000 roles_configured=true
```

Only 14 of 20 questions completed - 6 hit the same gateway-side "Request
timed out... waiting for response headers" hiccup documented in the first
baseline above and in `docs/routing-eval.md`'s "Gateway host gotcha"
section, and 6 of them were among the 8 that finished sooner in the first
run; this is the same unresolved, previously-investigated gateway issue,
not a Task 9 regression - re-running showed a different subset of
questions timing out each time, and the harness's own job (catch, log,
keep scoring the rest, never silently drop a question) worked as intended.
Because a different, smaller subset of questions completed than the first
baseline's 18, citation precision (0.5556 -> 0.5833) and nugget recall
(0.1944 -> 0.1607) are **not a clean before/after comparison on the same
question set** - both stayed in the same small-`n`, noisy range, not a
demonstrated regression or improvement from the `verify` role itself.

**Resolvability is the number this task set out to fix, and it moved from
having nothing to measure to a real, mostly-passing number**:
`resolvability=1.0000` over 5 checkable citations (9 of 14 completed
questions still had no citation carrying a `url` or DOI-shaped `id` -
`markets`/`news_global`/others cite sources whose id/text genuinely has
neither). Those 5 came from `literature`, `real_estate`, `science`,
`standards`, and `video` - each resolved live, confirming both halves of
the fix work end to end: `buildCitations()`'s `previewUrl`/`downloadUrl`
fallback actually produces a checkable URL for these previously-URL-less
citations, and `checkLiveness()`'s guarded, pinned HEAD/GET (through
`src/utils/liveness.ts`, cached 24h in the state store under `live|<url>`)
correctly reaches and confirms them.

### To re-run (with claim verification and grading)

Same env as "To re-run" above; claim verification is on by default (set
`ALEXANDRIA_CLAIM_CHECK=off` to disable it) and uses the `verify` role,
which needs no separate configuration - it falls back to whatever `synth`
resolves to. To point verify at a different model, set
`ALEXANDRIA_VERIFY_MODEL` (and `_BASE_URL`/`_API_KEY` if it's a different
gateway) alongside the vars above.

## 2026-09-03, Task 10: cross-encoder rerank backends and margin-gated multi-query

`src/utils/rerank.ts` (new) replaces `fuse.ts`'s `llmRerank` with a single
`rerank(query, candidates, { backend, top })` entry point behind
`ALEXANDRIA_RERANK: off | llm | cohere | workers-ai`. `library_answer`
hands it the RRF-fused pool capped to `ALEXANDRIA_RERANK_POOL` (default
60, was a fixed 40); the `llm` backend further caps its own listwise input
to the top 20 of that pool, shuffled before the prompt (position-bias
mitigation per `research/retrieval-sota.md` section 1). `cohere` POSTs
`<rerank base>/rerank` in the Cohere/Jina/Voyage/LiteLLM-shared request
shape; `workers-ai` POSTs Cloudflare's `{query, contexts}` shape straight
to `ALEXANDRIA_RERANK_BASE_URL` (already the full per-account model run
URL for that backend). Both are covered by stubbed-endpoint tests in
`src/utils/rerank.test.ts`, not by a live run here - see below.

### Cohere-shape backend: not measured live

The brief asked for one live run with `ALEXANDRIA_RERANK=cohere` against
the Cave LiteLLM gateway's `/rerank`, fronting
`nvidia_nim/nvidia/llama-3_2-nv-rerankqa-1b-v2`. Before wiring anything,
that exact model was probed directly:

```
POST http://100.78.123.100:4001/v1/rerank {"model":"nvidia_nim/nvidia/llama-3_2-nv-rerankqa-1b-v2", ...}
-> 410 {"detail":"This endpoint has reached its end of life on 2026-05-18T00:00:00Z and is no longer available."}
POST http://100.78.123.100:4001/rerank   (same body) -> identical 410
```

Both paths reach LiteLLM's rerank handler correctly (it parses the
request and reports "Received Model Group=..." before forwarding) -
confirming the request shape itself is accepted at either `/rerank` or
`/v1/rerank` - but the specific NVIDIA NIM-hosted reranker model is
permanently gone upstream, not a network or routing problem this repo
can work around. The gateway's other two rerank-named models fail closed
too:

```
nvidia_nim/nvidia/nv-rerankqa-mistral-4b-v3          -> 404 Not Found (function id not found for account)
nvidia_nim/ranking/nvidia/llama-3.2-nv-rerankqa-1b-v2 -> 404 page not found
```

No rerank endpoint on the configured gateway is reachable, so **the
`cohere` backend's effect on citation precision/nugget recall/
resolvability is not measured** in this environment. Running
`eval:answer` with `ALEXANDRIA_RERANK=cohere` anyway would be
scientifically meaningless here: every call would hit `cohereRerank()`'s
catch block (confirmed by `src/utils/rerank.test.ts`'s stubbed-server
tests) and fall back to the plain fused order, producing numbers
indistinguishable from the `off` baseline below modulo ordinary run-to-run
LLM/gateway noise - not a test of reranking quality at all. Workers AI
cannot be probed here either (no Cloudflare account/token in this
environment); its `{query, contexts}` request/response shape is
implemented against the documented API and exercised only by
`rerank.test.ts`'s stub.

### Margin-gated multi-query: measured

`ALEXANDRIA_MULTI_QUERY=1` only touches which sources `library_ask`'s
stage 2 sees (docs/routing-eval.md's Task 10 section has the routing-level
numbers); its effect on `library_answer`'s own citation quality flows
through indirectly, via which sources get searched, read, and cited. Two
runs, same gateway/models/env as "To re-run" above
(`ALEXANDRIA_STATE_DB=:memory:`, `ALEXANDRIA_RERANK` unset/off in both):

```
off:                citation_precision=0.5000 nugget_recall=0.1944 resolvability=0.8125 (18/20 completed)
ALEXANDRIA_MULTI_QUERY=1: citation_precision=0.7143 nugget_recall=0.1974 resolvability=0.8095 (19/20 completed)
```

As with Task 9's before/after, **this is not a clean same-question-set
comparison**: 2 questions timed out in the `off` run and a different 1
timed out in the `on` run (the same gateway-side "Request timed out...
waiting for response headers" hiccup `docs/routing-eval.md`'s "Gateway
host gotcha" section already documents - not chased as a bug here), so 18
and 19 questions respectively were actually scored, not the same 18. The
precision jump (0.5000 -> 0.7143) is consistent with multi-query
surfacing better sources for the previously-hardest routing cases, but at
n=18-19 with a different question set each time it is not strong evidence
on its own - nugget recall (0.1944 -> 0.1974) and resolvability (0.8125 ->
0.8095) barely moved, which is the more representative signal at this
sample size. Combined with the LLM-cost finding in docs/routing-eval.md
(2.45x router-role calls on already-ambiguous queries), this is
consistent with "does no harm, plausibly helps, costs more" rather than a
confirmed answer-quality win - hence still shipping default-off.

### To re-run

Same env as "To re-run (with claim verification and grading)" above, plus
`ALEXANDRIA_RERANK=cohere|workers-ai|llm` (pointed at a reachable
`/rerank`-shaped endpoint for `cohere`, or a Workers AI model run URL for
`workers-ai`) and/or `ALEXANDRIA_MULTI_QUERY=1`.
