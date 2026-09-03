# Fetch tier runtime (task 13)

Four changes to `src/web/fetchTier.ts` and its surroundings, all about how
the server behaves as a *runtime* rather than what it fetches: extraction
runs off the event loop, a fast markdown hop skips extraction entirely on
sites that offer it, the UA identifies this server honestly instead of
impersonating a browser, and `/mcp` over HTTP gets DNS-rebinding guards
plus a per-client rate limit.

## Extraction off the event loop

Tier 1's `parseHTML` + Defuddle call used to run inline, on the same
thread that answers every other concurrent MCP request (including a plain
`GET /health`). Both are synchronous, CPU-bound DOM work; on a large page
this is multiple seconds, and for that whole span nothing else this
process is doing could make progress.

`src/web/extractWorker.ts` now holds the actual algorithm
(`runExtraction(html, url)`), and `src/web/extract.ts` runs it on one
lazily-started `node:worker_threads` worker instead of the main thread.
One worker, not one per call: extraction isn't frequent enough to justify
a fresh thread's startup cost each time, and a single worker gives a
simple place to hang a 30s per-job timeout and crash recovery - a job that
blows past the timeout, or a worker that crashes (`'error'`/`'exit'`),
tears the worker down and rejects whatever was still pending against it;
the next `extractHtml()` call lazily starts a replacement. If a `Worker`
can't even be constructed (worker_threads unavailable in this
environment, as opposed to a transient crash), `extractHtml()` falls back
to calling `runExtraction()` directly, in-thread - same algorithm, same
result shape, just back on the main thread.

`extractWorker.ts` doubles as both the worker entry point and the
in-thread fallback's implementation: it checks `parentPort` at module load
to decide whether to wire up a message handler, so the exact same file
works loaded as a worker (`new Worker(...)`) or imported as a plain module
(`extract.ts`'s fallback path). The worker script's own file is located
relative to `import.meta.url`, matching the loading module's extension
(`.ts` under native execution, `.js` after `npm run build`) rather than a
hardcoded one - this is what lets `new Worker(...)` resolve correctly
whether the process is running from `src/` or from `dist/`.

Measured on the same two fixtures the pre-task Rust spike used
(`pg1342.htm`, Pride and Prejudice, 0.8 MB; a Byzantine Empire Wikipedia
mirror, 1.6 MB): run in-thread, extracting either page fully blocks the
event loop for the whole extraction - a concurrent `/health` request
simply cannot be answered until the extraction finishes (in one
measurement, zero of ~30 attempted `/health` pings landed during a 4.2s
extraction; the only one that got through was the one issued right after
it completed). Run through the worker, the same extractions kept `/health`
answering in single-digit milliseconds through most of the run, with
occasional spikes into the tens of milliseconds on this shared,
noisy 4-core box - see the task 13 report for the full numbers and an
honest read on the handful of samples that briefly touched ~50-70ms under
load.

## Markdown for Agents

Cloudflare's Markdown for Agents (see `research/cloudflare-platform.md`
section 4): a participating zone answers `Accept: text/markdown` with
`content-type: text/markdown` and an `x-markdown-tokens` header instead of
its ordinary HTML. Tier 1 now sends `Accept: text/markdown,
text/html;q=0.9`; when the response actually comes back as
`text/markdown`, that body is used directly as `text` (`via: 'markdown'`),
skipping Defuddle (and the worker hop above) entirely - there's no DOM to
build and nothing left to strip. A zone that doesn't participate just
answers its normal HTML at the `q=0.9` fallback, exactly as before.

## Honest User-Agent

The default UA sent by tier 1 changed from an impersonated
`Chrome/131.0.0.0` desktop string to `Alexandria/<version>
(+https://github.com/The-40-Thieves/alexandria-mcp)` - identifying,
versioned, and pointing back at the project, rather than pretending to be
a browser. Overridable per deployment via `ALEXANDRIA_FETCH_UA`.

`npm run probe` was run once against every source before this change and
once after (see the task 13 report for the full before/after status
table). No source's probe status regressed from the UA change alone; a
site that specifically depended on the browser UA would show up as a new
`ERROR`/`EMPTY`/`TIMEOUT` in that diff, and none did in this run. If a
future probe run does turn up a regression traceable to the UA, the fix is
a per-adapter `headers` override restoring the old browser UA for that one
call site (fetchTier.ts's `browserUA()` reads `ALEXANDRIA_FETCH_UA` first,
so a global override is also available without patching source), not
reverting the default for everyone.

## HTTP guards (`src/httpGuards.ts`, TRANSPORT=http only)

Applied to `/mcp` only - `/health` and `/metrics` carry no session state
worth protecting the same way:

- **Host/Origin validation** (`checkOrigin`): DNS-rebinding protection via
  `@modelcontextprotocol/node`'s `hostHeaderValidation`/`originValidation`,
  checked against `ALEXANDRIA_ALLOWED_ORIGINS` (a comma-separated list of
  hostnames, no scheme or port). Loopback (`localhost`, `127.0.0.1`,
  `[::1]`) is always allowed, regardless of that setting. A request that
  fails either check gets a `403` (the guard itself writes that response,
  per `@modelcontextprotocol/node`'s own contract).
- **Per-client-IP rate limit** (`checkRateLimit`): a token bucket keyed on
  `req.socket.remoteAddress`, capacity `ALEXANDRIA_HTTP_RATE_LIMIT`
  (default 60), refilling continuously back toward that cap over a
  one-minute window. Starts full, so a client's first burst up to the cap
  is never rejected - only sustained traffic above the configured
  per-minute rate is. Exceeding it returns `429` with a JSON-RPC error
  body (`{"jsonrpc":"2.0","error":{"code":-32000,"message":"rate limit
  exceeded"},"id":null}`), matching the shape of every other `/mcp`
  rejection instead of a bare HTTP status page.

Both guards run in `createHttpApp()`'s `/mcp` branch, before the request
ever reaches `handleMcpRequest`/the MCP transport.
