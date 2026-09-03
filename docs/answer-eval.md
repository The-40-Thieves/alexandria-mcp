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
always exits 0.

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
