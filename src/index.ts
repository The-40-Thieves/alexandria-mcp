import { randomUUID } from 'node:crypto';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import express from 'express';
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
import { installDispatcher } from './utils/dispatcher.ts';
import { requestContext } from './utils/http.ts';
import { metricsSnapshot, sourceCallTotals, toolMetrics } from './utils/metrics.ts';
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
/**
 * Handle one MCP HTTP request on its own server and transport.
 *
 * Stateless: nothing is shared between requests, so overlapping requests cannot
 * collide on a single Protocol instance. Errors are forwarded to the JSON-RPC
 * error handler below rather than to Express's default HTML renderer.
 */
async function handleMcpRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
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
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    next(err);
  }
}

/**
 * Express error handler. Returns a JSON-RPC error object so a thrown error can
 * never leak an HTML page or a stack trace to the caller.
 */
function jsonRpcErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err: message }, 'request failed');
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({
    jsonrpc: '2.0',
    error: { code: -32603, message },
    id: null,
  });
}

/** Build the HTTP app without binding a port, so tests can drive it in process. */
export function createHttpApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.post('/mcp', handleMcpRequest);
  app.get('/mcp', handleMcpRequest);
  app.delete('/mcp', handleMcpRequest);
  app.get('/health', (_req, res) => {
    const { sources, visible, hidden, byKind, quota, cache } = healthSummary();
    const { calls, errors } = sourceCallTotals();
    res.json({
      status: 'ok',
      version: VERSION,
      sources: { total: sources, visible, hidden, calls, errors },
      byKind,
      quota,
      cache,
      tools: TOOL_COUNT,
    });
  });
  app.get('/metrics', (_req, res) => {
    res.json(metricsSnapshot());
  });
  app.use(jsonRpcErrorHandler);
  return app;
}

async function runHTTP(): Promise<void> {
  const app = createHttpApp();
  const port = config.PORT;
  app.listen(port, () =>
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
  const run = config.TRANSPORT === 'http' ? runHTTP : runStdio;
  run().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
    process.exit(1);
  });
}

// Only start a transport when run as the entrypoint; importing this module
// (the HTTP test does) must not open stdio or bind a port.
if (import.meta.main) {
  main();
}
