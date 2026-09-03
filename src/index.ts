import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isJsonContentType, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { config, loadConfig } from './config.ts';
import { log } from './log.ts';
import { indexText, ingestText } from './pipeline/index.ts';
import { getAdapter, healthSummary, listSources } from './sources/registry.ts';
import { s2Recommend } from './sources/semanticscholar.ts';
import { libraryAnswer } from './tools/libraryAnswer.ts';
import { libraryAsk } from './tools/libraryAsk.ts';
import { libraryResearch, type ProgressCallback } from './tools/libraryResearch.ts';
import type { LibrarySource } from './types.ts';
import { closeDispatchers, installDispatcher } from './utils/dispatcher.ts';
import { requestContext } from './utils/http.ts';
import { metricsSnapshot, sourceCallTotals, toolMetrics } from './utils/metrics.ts';
import { closeStateStore } from './utils/stateStore.ts';
import { VERSION } from './version.ts';

import './sources/all.ts';

// The nine public tools registered below (library_list_sources, library_ask,
// library_search, library_read, library_index, library_ingest,
// library_recommend, library_answer, library_research). Kept as a literal
// count rather than introspected from the SDK: tools/list must not vary per
// connection (see the plan's Global Constraints), so this is a fixed fact
// about this file, not a runtime measurement.
const TOOL_COUNT = 9;

const SourceSchema = z
  .string()
  .describe('Library source name. Run library_list_sources for the current list and descriptions.');
function toStructured(val: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(val)) as Record<string, unknown>;
}

// Wraps one MCP tool invocation: bumps that tool's `invocations` counter
// (src/utils/metrics.ts) and runs the handler inside a fresh reqId/tool
// AsyncLocalStorage scope (src/utils/http.ts's requestContext), so
// log.ts's requestLogger() and providers.ts's llmCalls counter can
// attribute to "which tool call is this" without a parameter threaded
// through every function in between. registry.ts's own inner
// requestContext.run() (scoped to one adapter search()/read() call) merges
// this outer store rather than replacing it, so reqId/tool survive into a
// guarded adapter call too.
function withRequestContext<T>(tool: string, handler: () => Promise<T>): Promise<T> {
  toolMetrics(tool).invocations++;
  return requestContext.run({ reqId: randomUUID(), tool }, handler);
}

/**
 * Build a fresh McpServer with the nine public tools registered.
 *
 * HTTP mode calls this once per request: Protocol.connect rejects a second
 * transport attaching to a server that already has one (SdkErrorCode
 * AlreadyConnected), which a single shared instance hits as soon as two
 * requests overlap. A server and transport per request is the SDK's documented
 * stateless pattern. stdio keeps one long-lived server for its single session.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'alexandria', version: VERSION });

  // ── library_list_sources ─────────────────────────────────────────────────────
  server.registerTool(
    'library_list_sources',
    {
      title: 'List Available Library Sources',
      description: `List all ${listSources().length} library sources (count computed from the live registry at startup) with descriptions and capabilities.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      withRequestContext('library_list_sources', async () => {
        const sources = listSources();
        const text = sources
          .map(
            (s) =>
              `${s.name} [${s.kind}/${s.cluster}] [${s.supportsIngest ? 'full text' : 'metadata'}]: ${s.description}`,
          )
          .join('\n');
        return { content: [{ type: 'text', text }], structuredContent: { sources } };
      }),
  );

  // ── library_ask (natural language) ───────────────────────────────────────────
  server.registerTool(
    'library_ask',
    {
      title: 'Natural Language Library Search',
      description: `Ask for content in plain English. Automatically selects the best sources from all ${listSources().length} libraries, generates optimized per-source queries, and searches in parallel. Returns unified, deduplicated results.

  Examples:
    "recent papers on diffusion models for music generation"
    "ancient Greek texts about rhetoric and persuasion"
    "US military records from World War II"
    "source code documentation for the fastify web framework"
    "open access books on cognitive science"

  Requires OPENAI_API_KEY (already set for embeddings).
  Returns: { query, intent, sources_searched, total_results, results[], routing[], stage1 ('embeddings'|'bm25'), stage2 ('llm'|'skipped'), errors[] }`,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(1000)
          .describe('Natural language description of what you want to find'),
        max_sources: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe('Max number of sources to search (default 5)'),
        results_per_source: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe('Results to fetch per source (default 5)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, max_sources, results_per_source }) =>
      withRequestContext('library_ask', async () => {
        try {
          const result = await libraryAsk(query, max_sources, results_per_source);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: toStructured(result),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_search ────────────────────────────────────────────────────────────
  server.registerTool(
    'library_search',
    {
      title: 'Search Library Source',
      description: `Search a specific library source by name. Use library_ask instead for natural language queries across multiple sources.

  Sources marked [full text] support library_read and library_ingest.
  Sources marked [metadata] return discovery info and external URLs only.

  Returns: Array of { id, source, title, authors, year, language, subjects, hasFullText, previewUrl, description }`,
      inputSchema: z.object({
        query: z.string().min(1).max(300).describe('Title, author, subject, or keywords'),
        source: SourceSchema,
        limit: z.number().int().min(1).max(20).default(10).describe('Max results'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, source, limit }) =>
      withRequestContext('library_search', async () => {
        try {
          const results = await getAdapter(source).search(query, limit);
          const text =
            results.length === 0
              ? `No results for "${query}" on ${source}.`
              : JSON.stringify(results, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: { results } };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_read ──────────────────────────────────────────────────────────────
  server.registerTool(
    'library_read',
    {
      title: 'Read Full Text or Metadata',
      description: `Fetch text from a library source. Full-text sources return cleaned text (truncated at 200k chars). Metadata sources return item details and an external URL.

  Returns: { title, authors, year?, language?, text?, charCount?, truncated?, metadataOnly?, externalUrl?, note? }`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Item identifier from library_search or library_ask'),
        source: SourceSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, source }) =>
      withRequestContext('library_read', async () => {
        try {
          const result = await getAdapter(source).read(id);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: toStructured(result),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_index ─────────────────────────────────────────────────────────────
  server.registerTool(
    'library_index',
    {
      title: 'Preview Chunking (Dry Run)',
      description: `Dry run: fetch text, chunk semantically, score OCR quality. No writes. Full-text sources only.
  Returns: { totalChunks, droppedChunks, avgQualityScore, estimatedTokens, sampleChunks[0..2] }`,
      inputSchema: z.object({ id: z.string().min(1), source: SourceSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, source }) =>
      withRequestContext('library_index', async () => {
        try {
          const adapter = getAdapter(source);
          if (!adapter.supportsIngest)
            return {
              content: [{ type: 'text', text: `"${source}" is metadata-only.` }],
              isError: true,
            };
          const result = await adapter.read(id);
          if (!result.text)
            return {
              content: [{ type: 'text', text: `No text for ${source}:${id}` }],
              isError: true,
            };
          const preview = indexText(
            result.text,
            source as LibrarySource,
            id,
            result.title,
            result.authors,
            result.year,
            result.language,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }],
            structuredContent: toStructured(preview),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_ingest ────────────────────────────────────────────────────────────
  server.registerTool(
    'library_ingest',
    {
      title: 'Ingest Into Vector Database',
      description: `Chunk, embed, and store a text. Idempotent. Full-text sources only. Requires OPENAI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
  Returns: { chunksWritten, chunksDropped, skippedDuplicate, title, sourceId }`,
      inputSchema: z.object({ id: z.string().min(1), source: SourceSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, source }) =>
      withRequestContext('library_ingest', async () => {
        try {
          const adapter = getAdapter(source);
          if (!adapter.supportsIngest)
            return {
              content: [{ type: 'text', text: `"${source}" is metadata-only.` }],
              isError: true,
            };
          const result = await adapter.read(id);
          if (!result.text)
            return {
              content: [{ type: 'text', text: `No text for ${source}:${id}` }],
              isError: true,
            };
          const ingestResult = await ingestText(
            result.text,
            source as LibrarySource,
            id,
            result.title,
            result.authors,
            result.year,
            result.language,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(ingestResult, null, 2) }],
            structuredContent: toStructured(ingestResult),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_recommend ─────────────────────────────────────────────────────────
  server.registerTool(
    'library_recommend',
    {
      title: 'Get Similar Papers (Semantic Scholar)',
      description: `Get papers similar to a given paper using Semantic Scholar's recommendation engine. Pass a paperId from a semanticscholar search result. Returns up to 500 similar papers.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Semantic Scholar paperId'),
        limit: z.number().int().min(1).max(500).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, limit }) =>
      withRequestContext('library_recommend', async () => {
        try {
          const results = await s2Recommend(id, limit);
          const text =
            results.length === 0
              ? `No recommendations for paper ${id}.`
              : JSON.stringify(results, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: { results } };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_answer ────────────────────────────────────────────────────────────
  server.registerTool(
    'library_answer',
    {
      title: 'Answer With Cited Sources',
      description: `Ask a question in plain English and get a synthesized answer with inline [n] citations. Routes and searches like library_ask, fuses the per-source results with reciprocal rank fusion, reads the top full-text results, and asks an LLM to answer using only those sources. Every factual sentence is cited or marked "not found in the sources"; sentences with a dangling citation are dropped. If the answer had no citation markers at all, or every sentence was dropped as uncited, a message is added to warnings[] (and, in the all-dropped case, answer falls back to a plain listing of the source titles).

  At most 40 fused results are passed to the rerank stage (RERANK_POOL_CAP in src/tools/libraryAnswer.ts); a broader fan-out still searches every routed source, it just reranks the top 40.

  Requires OPENAI_API_KEY (or ALEXANDRIA_SYNTH_API_KEY).
  Returns: { answer, citations[], results[], routing[], warnings[] }`,
      inputSchema: z.object({
        query: z.string().min(1).max(1000).describe('Natural language question'),
        max_sources: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(6)
          .describe('Max number of sources to search (default 6)'),
        results_per_source: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe('Results to fetch per source (default 5)'),
        read_top: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(4)
          .describe('How many top full-text results to read and cite (default 4)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, max_sources, results_per_source, read_top }) =>
      withRequestContext('library_answer', async () => {
        try {
          const result = await libraryAnswer(query, {
            maxSources: max_sources,
            resultsPerSource: results_per_source,
            readTop: read_top,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: toStructured(result),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  // ── library_research ──────────────────────────────────────────────────────────
  server.registerTool(
    'library_research',
    {
      title: 'Recursive Cited Research',
      description: `Deep research on a topic: generates search queries, answers each with library_answer, extracts learnings and follow-up questions, then recurses with half the breadth. Stops at the given depth, the time budget, or once a round finds no new sources. Writes a final cited report over the union of every round's sources, then removes unsupported claims it can excise unambiguously, listing any it left standing in warnings[].

  Requires OPENAI_API_KEY (or ALEXANDRIA_RESEARCH_API_KEY / ALEXANDRIA_SYNTH_API_KEY).
  Returns: { report, citations[], rounds[], elapsedMs, warnings[] }`,
      inputSchema: z.object({
        query: z.string().min(1).max(1000).describe('Research topic or question'),
        depth: z.number().int().min(1).max(5).default(2).describe('Recursion depth (default 2)'),
        breadth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(4)
          .describe('Queries generated in the first round; halves each round (default 4)'),
        max_minutes: z
          .number()
          .positive()
          .max(30)
          .default(6)
          .describe('Wall-clock time budget in minutes (default 6)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, depth, breadth, max_minutes }, ctx) =>
      withRequestContext('library_research', async () => {
        try {
          const progressToken = ctx.mcpReq._meta?.progressToken;
          const onProgress: ProgressCallback = async (info) => {
            if (progressToken !== undefined) {
              await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, progress: info.round, message: info.message },
              });
            } else {
              await server.sendLoggingMessage({ level: 'info', data: info.message });
            }
          };
          const result = await libraryResearch(
            query,
            { depth, breadth, maxMinutes: max_minutes },
            onProgress,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: toStructured(result),
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }),
  );

  return server;
}

// ── HTTP / stdio transport ────────────────────────────────────────────────────

// express.json()'s default: reject a body over 100kb before it reaches
// JSON.parse, rather than buffering an unbounded request in memory. Dropping
// Express (SDK v2's WebStandardStreamableHTTPServerTransport.handlePostRequest
// calls `await req.json()` with no size cap of its own when no parsedBody is
// supplied) means this repo now enforces that cap itself instead of getting
// it for free from body-parser.
const JSON_BODY_LIMIT_BYTES = 100 * 1024;

// Reads req's body up to JSON_BODY_LIMIT_BYTES and JSON.parses it, mirroring
// express.json()'s size-then-parse behavior. Only called for a JSON
// content-type, gated on the SDK's own isJsonContentType() - the same
// case-insensitive, parameter-tolerant check handlePostRequest itself uses
// to decide whether to read the body at all. A hand-rolled case-sensitive
// `includes('application/json')` here previously let a header like
// `Application/JSON` skip this cap entirely and reach the SDK's own
// unbounded read. GET/DELETE /mcp (no body) and any non-JSON content-type
// still pass `undefined` through to the transport unchanged, same as
// express.json() no-oping on those today.
// Final wave, A10: distinguishes the oversize case from any other body-read
// failure so handleMcpRequest's catch below can destroy the request's
// socket - never stopped before - without touching the ordinary error
// path used by every other kind of failure.
class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > JSON_BODY_LIMIT_BYTES) {
      throw new PayloadTooLargeError(
        `request entity too large (limit ${JSON_BODY_LIMIT_BYTES} bytes)`,
      );
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Handle one MCP HTTP request on its own server and transport.
 *
 * Stateless: nothing is shared between requests, so overlapping requests cannot
 * collide on a single Protocol instance. Errors are forwarded to the JSON-RPC
 * error handler below rather than leaking an HTML page or a stack trace.
 */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Captured up front, deliberately not read off `req` later (final wave,
  // A10 review round 2): by the time readJsonBody()'s `for await` throws
  // on an oversize body, Node's async-iterator protocol has already
  // called the stream's own `.return()` as part of unwinding the loop,
  // which destroys `req`'s readable side - so `req.destroyed` is already
  // true by the catch block below, and calling req.destroy() there does
  // NOT tear down the underlying TCP connection (req.socket has already
  // been detached from req by then, so IncomingMessage#destroy() has
  // nothing left to close). The raw net.Socket captured here, before any
  // of that happens, is the one reference still guaranteed connected.
  const sock = req.socket;
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    const body = isJsonContentType(req.headers['content-type'])
      ? await readJsonBody(req)
      : undefined;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    jsonRpcErrorHandler(err, res);
    if (err instanceof PayloadTooLargeError) {
      // Destroying the socket immediately (before the 500 response is
      // flushed) would sever the connection out from under
      // jsonRpcErrorHandler's own res.end() above - res 'finish' fires
      // once that response is fully handed off, only then is it safe to
      // stop a peer that was still sending (possibly megabytes) more than
      // this request needed.
      res.on('finish', () => sock?.destroy());
    }
  }
}

/**
 * Returns a JSON-RPC error object so a thrown error can never leak an HTML
 * page or a stack trace to the caller.
 */
function jsonRpcErrorHandler(err: unknown, res: ServerResponse): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err: message }, 'request failed');
  if (res.headersSent) {
    res.end();
    return;
  }
  // JSON.stringify before writeHead, deliberately: if this throws (it
  // shouldn't, `message` is always a string, but see sendJson's comment for
  // why the ordering matters regardless), no headers have gone out yet and
  // whatever called this can still fall back to a plain res.end().
  const payload = JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null });
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(payload);
}

// Serializes before writeHead, not after: writeHead commits the response's
// status/headers immediately, so a JSON.stringify(body) that throws AFTER
// writeHead(200, ...) has already run leaves a 200 response with no body on
// the wire and nothing jsonRpcErrorHandler's `res.headersSent` check can
// recover - the caller sees an empty 200, not a JSON-RPC error. Serializing
// first means a throw here propagates to createHttpApp's try/catch before
// any header has been sent, so jsonRpcErrorHandler can still send a clean
// 500 envelope.
// method defaults to 'GET': every existing call site sends a body. HEAD
// (final wave, A10) still computes the payload - so content-length and any
// serialization error match the GET response byte for byte - but writes no
// body, the way Express's default HEAD handling for a GET route did.
function sendJson(res: ServerResponse, body: unknown, method = 'GET'): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(method === 'HEAD' ? undefined : payload);
}

// Strips a query string from a raw request target - deliberately NOT via
// `new URL(req.url, base)`: Node's own HTTP request-line parser is far more
// lenient than the WHATWG URL parser and hands a target like `//[`,
// `http://[`, or `http://%/` straight through as `req.url` verbatim; feeding
// that into `new URL()` throws synchronously inside a plain node:http
// request listener, which Node treats as an uncaught exception and exits
// the process on a single unauthenticated request. A plain string split
// never throws, whatever the target looks like.
function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?', 1)[0] ?? '/';
}

/** Build the HTTP server without binding a port, so tests can drive it in process. */
export function createHttpApp(): Server {
  return createHttpServer((req, res) => {
    // Guards the whole dispatch below, not just handleMcpRequest's own try
    // block: a throw from requestPath (see its comment), or from
    // healthSummary()/sourceCallTotals()/metricsSnapshot()/JSON.stringify
    // while building /health or /metrics's response, would otherwise be an
    // uncaught synchronous exception in this listener - fatal to the whole
    // process - instead of a JSON-RPC error answer to the one request.
    try {
      const path = requestPath(req);
      // /mcp alone gets Express's old case-insensitive, trailing-slash-
      // tolerant matching back (`/MCP`, `/mcp/` both routed); /health and
      // /metrics stay exact-match. The README documents their methods
      // (GET /health, GET /metrics), not this path-matching strictness -
      // it is not a README-specified contract, just this handler's own
      // choice not to extend /mcp's tolerant matching to them.
      const mcpPath = path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
      if (
        mcpPath.toLowerCase() === '/mcp' &&
        ['POST', 'GET', 'DELETE'].includes(req.method ?? '')
      ) {
        void handleMcpRequest(req, res);
        return;
      }
      // HEAD alongside GET (final wave, A10): Express's default HEAD
      // handling for a GET route ran the same handler and dropped the
      // body; sendJson's `method` param reproduces that (headers,
      // including content-length, with no body).
      if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const { sources, visible, hidden, byKind, quota, cache } = healthSummary();
        const { calls, errors } = sourceCallTotals();
        sendJson(
          res,
          {
            status: 'ok',
            version: VERSION,
            sources: { total: sources, visible, hidden, calls, errors },
            byKind,
            quota,
            cache,
            tools: TOOL_COUNT,
          },
          req.method,
        );
        return;
      }
      if (path === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, metricsSnapshot(), req.method);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      jsonRpcErrorHandler(err, res);
    }
  });
}

async function runHTTP(): Promise<void> {
  const httpServer = createHttpApp();
  const port = config.PORT;
  httpServer.listen(port, () =>
    log.info(
      { sources: listSources().length, url: `http://localhost:${port}/mcp` },
      'alexandria started',
    ),
  );
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ sources: listSources().length }, 'alexandria started');
}

function main(): void {
  // Explicit, first thing: registry.ts, dispatcher.ts, and the rest of
  // config's ~50 consumers all read it lazily (see config.ts's module
  // comment), so an invalid env (a bad TRANSPORT, a non-numeric PORT)
  // would otherwise only surface on whatever config field the FIRST
  // registered source's first guarded call happens to touch - a confusing
  // place to learn startup failed. console.error, not log.error: log.ts's
  // own level()/destination() read config too, and would throw the exact
  // same way trying to report this failure.
  try {
    loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Before the transport starts: every source's fetchWithRetry() call picks
  // up the composed dispatcher (connection pooling, dns cache, RFC 9111
  // http cache) with no per-call change, since it's installed as undici's
  // global dispatcher. See src/utils/dispatcher.ts.
  installDispatcher();
  installShutdownHook();
  const run = config.TRANSPORT === 'http' ? runHTTP : runStdio;
  run().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
    process.exit(1);
  });
}

// Final wave, A11: one shutdown path for both transports (stdio and http
// alike - neither previously closed anything on exit). SIGTERM/SIGINT are
// the two signals a process manager (systemd, Docker, Coolify) and an
// interactive Ctrl+C send respectively; both close the dispatcher Agents'
// pooled connections and the state store's sqlite handle before exiting,
// logging one line either way. Idempotent against a second signal arriving
// mid-shutdown (`once`, and the listener removes itself first).
function installShutdownHook(): void {
  const shutdown = (signal: NodeJS.Signals) => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    log.info({ signal }, 'alexandria shutting down');
    closeStateStore();
    closeDispatchers()
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'error closing dispatchers',
        );
      })
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

// Only start a transport when run as the entrypoint; importing this module
// (the HTTP test does) must not open stdio or bind a port.
if (import.meta.main) {
  main();
}
