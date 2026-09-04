# Cloudflare integration guide

Everything in this doc is env-only or additive - none of it requires the
`hybrid, not a port` verdict below to change. Full research, with every
number and URL below sourced and dated, is in
`.superpowers/sdd/2026-09-03-alexandria-improvement-program/research/cloudflare-platform.md`
(checked live 2026-09-03).

## The hybrid verdict, and why

Alexandria stays a Node process (on Cave, or Railway) that *consumes*
Cloudflare services over HTTP, rather than a port of the server itself onto
Workers. Three of this repo's own runtime dependencies rule a full port
out today:

- **`node:sqlite` is a non-functional stub** under Workers'
  `nodejs_compat` ("can be imported or required, but does not provide a
  working implementation"). `StateStore`, the quota ledger, the result
  cache, the routing cache, and `SqliteCacheStore` (the RFC 9111 undici
  cache) all need a new backend - Durable Objects SQLite or D1 - before
  any of that code could run on Workers at all.
- **Workers' `fetch` doesn't honour undici dispatchers.** Per-request
  `dispatcher:` options and undici's `Agent`/`interceptors` API are not
  supported (Cloudflare built a bespoke shim only for its own Vitest
  integration). `src/utils/dispatcher.ts`'s `guardedDispatcher` is what
  pins the fetch tier's actual TCP connection to the address the SSRF
  guard just validated (`src/web/fetchTier.ts`'s `resolveFetchTarget`) -
  closing a DNS-rebinding TOCTOU gap between validation and connect. On
  Workers that pin can't be expressed (no `connect.lookup` hook), so the
  guard would collapse to pre-resolve-then-allowlist, a strictly weaker
  guarantee than what runs today.
- **Workers Paid caps a single invocation at 6 simultaneous connections
  "waiting for response headers"** (relaxed 2026-04-09 so body streaming no
  longer counts, but the header-wait cap itself is unchanged). `library_ask`
  fanning out to ~20 slow upstream library APIs would serialize into ~4
  sequential header-wait rounds on Workers - a real latency regression
  against Node's unlimited sockets, not a hypothetical one.

None of that blocks *using* Cloudflare from the Node process that already
runs: AI Gateway and Workers AI are plain HTTP calls through the existing
per-role provider table, R2 is S3-compatible, Browser Run is a REST POST,
and Tunnel/Access/WAF sit in front of the same `/mcp` this server already
serves. A full Workers port is rated M-L effort in the research doc, buys
no new capability Alexandria needs, and costs a measurable security
regression on the SSRF pin - not undertaken here.

## AI Gateway: BYOK for the LLM roles

Every LLM/embedding call already goes through `src/utils/providers.ts`'s
per-role table (`router`/`synth`/`research`/`embeddings`/`rerank`), each
resolved from `ALEXANDRIA_<ROLE>_BASE_URL`/`_API_KEY`/`_MODEL` falling back
to the shared `ALEXANDRIA_BASE_URL`/`ALEXANDRIA_API_KEY`. Pointing a role at
AI Gateway is exactly that fallback chain with a Cloudflare URL - no code
change, same as the README's existing LiteLLM recipe.

**New unified endpoint** (`api.cloudflare.com`, OpenAI SDK-compatible,
added 2026-05-21):

```env
ALEXANDRIA_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1
ALEXANDRIA_API_KEY=<Cloudflare API token>
ALEXANDRIA_ROUTER_MODEL=openai/gpt-4o-mini
```

The provider's own key (OpenAI, Anthropic, ...) is configured once in the
AI Gateway dashboard's BYOK settings, not passed per request - only the
Cloudflare API token travels as `ALEXANDRIA_API_KEY`. One caveat worth
knowing before relying on this for anything beyond a single default
gateway: Cloudflare's REST docs show a `cf-aig-gateway-id` request header
for targeting a *non-default* named gateway, which this server's plain
`baseURL`/`apiKey` client has no way to set - fine for the account's
default gateway, a real limitation if you run several gateways and need a
specific one.

**Legacy endpoint** (`gateway.ai.cloudflare.com`, still supported, the one
already documented in the README's ["Pointing roles at a
gateway"](../README.md#pointing-roles-at-a-gateway-instead-of-openai-directly)
section): the gateway ID lives in the URL path itself, so it needs no
extra header and is the simpler choice for a single named gateway:

```env
ALEXANDRIA_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai
ALEXANDRIA_API_KEY=<your OpenAI key, forwarded through the gateway>
```

Either way, AI Gateway's core features apply for free: response caching
(60s-1 month TTL), rate limiting, retries (up to 5, with backoff), spend
limits by model/provider, and logs. Don't enable gateway caching on the
`embeddings` role if the same text is ever re-embedded expecting a fresh
result through a different path (e.g. `library_ingest`'s corpus-as-cache).

## Workers AI: `embeddings` and `rerank` roles

Workers AI's OpenAI-compatible endpoints (`/v1/embeddings`,
`/v1/chat/completions`) live at the same unified base URL as above:

```env
ALEXANDRIA_EMBEDDINGS_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1
ALEXANDRIA_EMBEDDINGS_API_KEY=<Cloudflare API token>
ALEXANDRIA_EMBEDDINGS_MODEL=@cf/baai/bge-m3
```

`bge-m3` is $0.012/M input tokens, 1024-d, multilingual, 60k-token context
- the cheapest embedding model in Cloudflare's catalog and, per Task 10's
report, the exact model already exercised end to end against a LiteLLM
gateway front (`ALEXANDRIA_EMBEDDINGS_MODEL=BAAI/bge-m3`).

`rerank` is a true cross-encoder backend added in Task 10
(`ALEXANDRIA_RERANK=workers-ai`, `src/utils/rerank.ts`). Unlike the
embeddings/chat roles, this one POSTs directly to the model's per-account
*run* URL (not the OpenAI-compatible path), with Cloudflare's own
`{query, contexts}` request shape:

```env
ALEXANDRIA_RERANK=workers-ai
ALEXANDRIA_RERANK_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/run/@cf/baai/bge-reranker-base
ALEXANDRIA_RERANK_API_KEY=<Cloudflare API token>
```

At the stated scenario (5k reranks x 20 docs x 300 tokens = 30M tokens,
$0.003/M) this is about $0.09/month - inside the 10,000 neurons/day free
allowance for either plan. Caveat: `bge-reranker-base` is a 2023 278M
cross-encoder, weaker than newer hosted rerank models; there's no
OpenAI-shaped `/rerank` route, which is why this backend needed its own
~30-line adapter rather than reusing the `cohere` backend's request shape.

## Tunnel + Access: a private `/mcp`

`src/httpGuards.ts` already guards `/mcp` with Host/Origin validation
(`ALEXANDRIA_ALLOWED_ORIGINS`) and a per-client-IP rate limit
(`ALEXANDRIA_HTTP_RATE_LIMIT`). Putting a Cloudflare Tunnel plus Access in
front of it adds authentication Alexandria itself never implements:

1. Run `cloudflared tunnel` pointing at this server's `TRANSPORT=http`
   listener (no public port opened on the box - the tunnel is outbound-only).
2. Add an Access application over the tunnel's hostname, with a policy
   restricting who/what can reach it.
3. **Desktop MCP clients can't complete Access's browser-based OAuth
   login** - use an Access **service token** instead: create one in the
   Zero Trust dashboard, then pass its `CF-Access-Client-Id` /
   `CF-Access-Client-Secret` as headers on every request. Claude Desktop's
   config (which only takes a bare URL) needs `mcp-remote` in between to
   inject them:

   ```json
   {
     "mcpServers": {
       "library": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote@latest",
           "https://<your-tunnel-hostname>/mcp",
           "--header",
           "CF-Access-Client-Id: <CLIENT_ID>",
           "--header",
           "CF-Access-Client-Secret: <CLIENT_SECRET>"
         ]
       }
     }
   }
   ```

### `ALEXANDRIA_TRUSTED_PROXY`: per-client rate limiting behind a proxy

`checkRateLimit`'s token bucket keys on `req.socket.remoteAddress` by
default - which, once traffic reaches this server through a Tunnel or any
PaaS edge (Railway included), is the **proxy's** address for every caller,
not the caller's. Left unset, that collapses the whole rate limiter into
one shared bucket: the first handful of distinct real clients exhaust it
together, and every later, unrelated client is rejected until it refills.

Setting `ALEXANDRIA_TRUSTED_PROXY=1` switches the key to `CF-Connecting-IP`
(set by Cloudflare on every request that reaches your origin through it),
falling back to the first `X-Forwarded-For` entry when that header is
absent, and only falling back further to the socket address when neither
is present. This is an explicit opt-in, off by default, because trusting
either header from a caller you *haven't* put behind a proxy would let
that caller pick its own rate-limit bucket by sending a spoofed header
directly - only set it once `/mcp` is actually reachable exclusively
through a proxy that sets these headers itself.

```env
ALEXANDRIA_TRUSTED_PROXY=1
```

## WAF rate-limiting: a public `/mcp`

If `/mcp` is exposed directly through a Cloudflare zone (not behind
Access), a WAF rate-limiting rule adds edge-level throttling in front of
`ALEXANDRIA_HTTP_RATE_LIMIT`'s in-process one. Availability is
plan-gated: Free allows 1 rate-limiting rule per 10-second period, Pro 2,
Business 5 - thin, but free, and it blocks abusive traffic before it ever
reaches this process. Bot Fight Mode and WAF custom rules are free on every
plan and compose with it.

## R2 via S3: cached full texts (documented, not implemented)

R2 buckets speak the S3 API, so a Node process (this one, unmodified) can
read/write them with any S3-compatible client - no Workers code required.
At the stated scenario (5 GB of cached texts/PDFs), R2's free tier (10 GB
storage, 1M Class A + 10M Class B operations/month) covers it at $0, with
free egress. This is a real, low-effort option for durable full-text
storage if disk on the current host ever becomes the constraint that
matters, but nothing in this task wires it in - `library_ingest`'s storage
path stays Supabase/pgvector today; adding an R2-backed
`VectorStoreProvider`/text-cache would be its own, separate task.

## What a full Workers port would cost

Beyond the three blockers in the verdict above: `node:worker_threads` and
`node:child_process` are also stubs (Defuddle's off-thread extraction
worker and the repo's one `child_process` call site would both need
rewriting), and `node:fs` under Workers is a memory-only VFS with no
writable persistent path (`/tmp` is per-request, not shared) - ruling out
anywhere this server writes a file today. The research doc rates the
rewrite of `stateStore`, `dispatcher`, and `fetchTier` alone as M-L effort,
with the SSRF-pin regression above as a permanent cost, not a migration
hiccup. At the stated traffic scenario, hosting cost is a wash either way
(~$5.50-6/month on Workers Paid, driven mostly by the $5 plan minimum,
versus effectively $0 marginal cost on infrastructure already running).
The one thing a port buys is not running a box you already run - not
reason enough on its own to accept the security and latency regressions
above.
