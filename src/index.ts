#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type NodeMcpRequestHandler, toNodeHandler } from '@modelcontextprotocol/node';
import {
  type CallToolResult,
  createMcpHandler,
  isJsonContentType,
  McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { config, loadConfig } from './config.ts';
import { checkOrigin, checkRateLimit, configuredOriginHostnames } from './httpGuards.ts';
import { buildInstructions } from './instructions.ts';
import { log, requestLogger } from './log.ts';
import { indexText, ingestText } from './pipeline/index.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { assertIngestAllowed, ingestMetadata } from './sources/ingestPolicy.ts';
import { getAdapter, healthSummary, listSources } from './sources/registry.ts';
import { s2Recommend } from './sources/semanticscholar.ts';
import { TOOL_COUNT } from './toolCount.ts';
import { formatResult } from './tools/format.ts';
import {
  type AnswerProgressCallback,
  type AnswerProgressInfo,
  libraryAnswer,
} from './tools/libraryAnswer.ts';
import { libraryAsk } from './tools/libraryAsk.ts';
import { libraryCitations } from './tools/libraryCitations.ts';
import { libraryHealth } from './tools/libraryHealth.ts';
import { libraryResearch, type ProgressCallback } from './tools/libraryResearch.ts';
import type { LibrarySource } from './types.ts';
import { closeDispatchers, installDispatcher } from './utils/dispatcher.ts';
import { requestContext } from './utils/http.ts';
import { metricsSnapshot, sourceCallTotals, toolMetrics } from './utils/metrics.ts';
import { closeStateStore } from './utils/stateStore.ts';
import { VERSION } from './version.ts';
import { withOpenAccessFallback } from './web/openAccessFallback.ts';

import './sources/all.ts';

// The eleven public tools registered below (library_list_sources,
// library_ask, library_search, library_read, library_index,
// library_ingest, library_recommend, library_answer, library_research,
// library_health_check, library_citations). TOOL_COUNT itself lives in
// src/toolCount.ts, not here, so scripts/gen-docs.ts's README /health
// example can read the same value instead of carrying its own separate
// literal (task 2 review finding: those two drifted).

const SourceSchema = z
  .string()
  .describe('Library source name. Run library_list_sources for the current list and descriptions.');
function toStructured(val: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(val)) as Record<string, unknown>;
}

const ResponseFormatSchema = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe(
    'concise (default) trims results/citations to high-signal fields; detailed returns the full payload, including routing reasons, scores, and stage diagnostics.',
  );

// ── outputSchema building blocks ────────────────────────────────────────────
//
// Every tool's outputSchema below is the DETAILED shape, with every field a
// concise response omits made optional - the SDK validates
// `structuredContent` against this same schema on both response_format
// values (see ajvProvider / registerTool's outputSchema doc), so a
// concise-only-absent field cannot be required.

const ResultRowSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  hasFullText: z.boolean(),
  year: z.number().optional(),
  url: z.string().optional(),
  // Present in `response_format: "detailed"` only; concise rows omit them.
  authors: z.array(z.string()).optional(),
  language: z.string().optional(),
  subjects: z.array(z.string()).optional(),
  previewUrl: z.string().optional(),
  downloadUrl: z.string().optional(),
  description: z.string().optional(),
  published: z.string().optional(),
  cluster: z.string().optional(),
});

const RouteItemSchema = z.object({
  source: z.string(),
  query: z.string(),
  reason: z.string(),
});

// library_ask's `routing` is RouteItem[] in detailed mode, collapsed to
// plain source names in concise mode; the schema accepts either.
const AskRoutingSchema = z.array(z.union([RouteItemSchema, z.string()]));

const CitationSchema = z.object({
  n: z.number(),
  source: z.string(),
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  // Task 9 (isnad citation grading) fills these in; declared now, optional,
  // so this outputSchema never needs a breaking change when it lands.
  grade: z
    .object({
      tier: z.enum(['A', 'B', 'C', 'D']),
      signals: z.record(z.string(), z.unknown()),
    })
    .optional(),
  resolves: z.boolean().optional(),
  // Final wave (E4): detailed-only marker on a citation whose text came
  // from the corpus cache; `source`/`id` above are the chunk's original
  // (readable) pair either way.
  via: z.literal('corpus').optional(),
});

const AuthSpecSchema = z.object({
  type: z.string(),
  env: z.string().optional(),
  param: z.string().optional(),
  header: z.string().optional(),
});

const LibrarySourceInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  supportsIngest: z.boolean(),
  kind: z.string(),
  cluster: z.string(),
  freshness: z.string(),
  homepage: z.string().optional(),
  timeoutMs: z.number(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: AuthSpecSchema.optional(),
  pacing: z
    .object({ minIntervalMs: z.number().optional(), dailyCap: z.number().optional() })
    .optional(),
  verifiedAt: z.string().optional(),
  hidden: z.boolean(),
  optionalEnv: z.array(z.string()).optional(),
  ingestPolicy: z.enum(['allowed', 'attribution', 'timeboxed', 'forbidden']).optional(),
});

const SourceHealthSchema = z.object({
  name: z.string(),
  cluster: z.string(),
  status: z.enum(['ok', 'degraded', 'down', 'key_missing', 'unknown']),
  // Present in `response_format: "detailed"` only; concise rows omit them.
  kind: z.string().optional(),
  errorRate: z.number().optional(),
  avgLatencyMs: z.number().optional(),
  quotaUsed: z.number().optional(),
  note: z.string().optional(),
});

const LibraryCitationsSeedSchema = z.object({
  id: z.string(),
  source: z.string(),
  doi: z.string().optional(),
});

const ChunkMetadataSchema = z.object({
  source: z.string(),
  sourceId: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().optional(),
  language: z.string().optional(),
  section: z.string().optional(),
  chunkIndex: z.number(),
  totalChunks: z.number(),
  qualityScore: z.number(),
  license: z.string().optional(),
  attribution: z.string().optional(),
  expiresAt: z.string().optional(),
  // Final wave (E6): ChunkMetadata has carried these since review round 1
  // (they are what keeps a corpus-as-cache citation's url and grading
  // tier honest - see src/pipeline/corpusSearch.ts), and library_index's
  // sampleChunks payload has always included them; only this schema had
  // not caught up, so the declared output shape did not match what the
  // tool actually returns.
  url: z.string().optional(),
  cluster: z.string().optional(),
});

// embedText likewise: chunkSemantic() sets it whenever the embedded text
// differs from the displayed text (ALEXANDRIA_CHUNK_PREFIX), and it is in
// the payload.
const ChunkSchema = z.object({
  text: z.string(),
  embedText: z.string().optional(),
  metadata: ChunkMetadataSchema,
});

const ReadResultSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().optional(),
  language: z.string().optional(),
  text: z.string().optional(),
  charCount: z.number().optional(),
  truncated: z.boolean().optional(),
  truncatedAt: z.number().optional(),
  metadataOnly: z.boolean().optional(),
  externalUrl: z.string().optional(),
  note: z.string().optional(),
  doi: z.string().optional(),
  pages: z
    .array(z.object({ page: z.number(), charStart: z.number(), charEnd: z.number() }))
    .optional(),
  unavailable: z
    .object({
      reason: z.enum(['no_full_text', 'paywalled', 'not_found', 'too_large', 'blocked']),
      triedTiers: z.array(z.string()),
    })
    .optional(),
});

// library_answer's four progress stages (src/tools/libraryAnswer.ts's
// AnswerProgressInfo), mapped to the numeric `progress` notifications/
// progress expects.
const ANSWER_STAGE_INDEX: Record<AnswerProgressInfo['stage'], number> = {
  routed: 1,
  fetched: 2,
  read: 3,
  synthesised: 4,
};

// Factored from the inline progressToken dance every progress-emitting tool
// handler below needs: notify the caller's progressToken if the request
// carried one (notifications/progress), otherwise fall back to a plain
// logging message so a client with no progress token still sees the
// updates. Used by library_answer (stages: routed, fetched, read,
// synthesised), library_ingest (a start and an end notification), and
// library_research.
//
// A notification failure is swallowed here, never rethrown (task 1 review
// finding 3): by the time library_ingest's second call fires, ingestText()
// has already durably written its chunks, and by the time library_answer's
// last call fires, chatText() has already produced the answer - letting a
// transport hiccup on the notify itself turn either into a reported
// isError would tell the caller a persisted write or a completed answer
// failed when it did not.
export function progressReporter(
  server: McpServer,
  ctx: ServerContext,
): (progress: number, message: string) => Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  return async (progress, message) => {
    try {
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken, progress, message },
        });
      } else {
        await server.sendLoggingMessage({ level: 'info', data: message });
      }
    } catch (err) {
      requestLogger().debug(
        { err: err instanceof Error ? err.message : String(err) },
        'progress notification failed',
      );
    }
  };
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
 * Build a fresh McpServer with the ten public tools registered.
 *
 * HTTP mode calls this once per request: Protocol.connect rejects a second
 * transport attaching to a server that already has one (SdkErrorCode
 * AlreadyConnected), which a single shared instance hits as soon as two
 * requests overlap. A server and transport per request is the SDK's documented
 * stateless pattern. stdio keeps one long-lived server for its single session.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'alexandria', version: VERSION },
    { instructions: buildInstructions(listSources().length) },
  );

  // ── library_list_sources ─────────────────────────────────────────────────────
  server.registerTool(
    'library_list_sources',
    {
      title: 'List Available Library Sources',
      description: `List all ${listSources().length} library sources (count computed from the live registry at startup) with descriptions and capabilities.`,
      inputSchema: z.object({}),
      outputSchema: z.object({ sources: z.array(LibrarySourceInfoSchema) }),
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

  // ── library_health_check ─────────────────────────────────────────────────────
  server.registerTool(
    'library_health_check',
    {
      title: 'Check Source Health',
      description: `Report per-source health: 'ok', 'degraded', 'down', 'key_missing', or 'unknown', merging this process's live error rate and latency with the last off-process probe run. The probe layer reads eval/probe-latest.json, which published installs do not ship, so on a published install a source's status stays 'unknown' until this process itself calls it. Use before relying on a source that has been erroring, or to check whether a key is configured. Optionally filter by source or cluster. Set response_format: "detailed" for error rate, latency, and quota usage.`,
      inputSchema: z.object({
        source: SourceSchema.optional(),
        cluster: z.string().optional().describe('Restrict to sources in this cluster'),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({
        generatedAt: z.string(),
        probeAt: z.string().optional(),
        sources: z.array(SourceHealthSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, cluster, response_format }) =>
      withRequestContext('library_health_check', async () => {
        // Final wave (E7): the only tool handler without a try/catch, so
        // any throw from libraryHealth() (a probe file of the wrong shape
        // made `results` undefined and threw on the first property read)
        // escaped the handler instead of answering isError like every
        // other tool. The shape guard in libraryHealth() closes that
        // particular hole; this closes the class.
        try {
          const result = libraryHealth({ source, cluster, response_format });
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

  // ── library_ask (natural language) ───────────────────────────────────────────
  server.registerTool(
    'library_ask',
    {
      title: 'Natural Language Library Search',
      description: `Ask for content in plain English; automatically selects the best sources from all ${listSources().length} libraries, generates optimized per-source queries, and searches in parallel. Use this as the default entry point for any natural-language request. Use library_search instead when you already know which source to query. Requires OPENAI_API_KEY (already set for embeddings). Set response_format: "detailed" for routing reasons and per-stage diagnostics.`,
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
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({
        query: z.string(),
        intent: z.string(),
        sources_searched: z.array(z.string()),
        total_results: z.number(),
        results: z.array(ResultRowSchema),
        routing: AskRoutingSchema,
        errors: z.array(z.object({ source: z.string(), error: z.string() })),
        stage1: z.enum(['embeddings', 'bm25']).optional(),
        stage2: z.enum(['llm', 'skipped']).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, max_sources, results_per_source, response_format }) =>
      withRequestContext('library_ask', async () => {
        try {
          const result = await libraryAsk(query, max_sources, results_per_source);
          const formatted = formatResult('ask', result, response_format);
          return {
            content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
            structuredContent: toStructured(formatted),
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
  Sources marked [metadata] return discovery info and external URLs only.`,
      inputSchema: z.object({
        query: z.string().min(1).max(300).describe('Title, author, subject, or keywords'),
        source: SourceSchema,
        limit: z.number().int().min(1).max(20).default(10).describe('Max results'),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ results: z.array(ResultRowSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, source, limit, response_format }) =>
      withRequestContext('library_search', async () => {
        try {
          const results = await getAdapter(source).search(query, limit);
          const formatted = formatResult('search', { results }, response_format);
          const text =
            formatted.results.length === 0
              ? `No results for "${query}" on ${source}.`
              : JSON.stringify(formatted.results, null, 2);
          // Task 14: detailed mode adds a resource_link per full-text result,
          // pointing at the library://doc/{source}/{id} template registered
          // in resources.ts - a client with resource support (Claude Code's
          // `@srv:uri`, VS Code's Add Context) can then pull the full text
          // directly, without a second library_read call. Concise mode skips
          // this: it is meant to stay small.
          const resourceLinks: CallToolResult['content'] =
            response_format === 'detailed'
              ? results
                  .filter((r) => r.hasFullText)
                  .map((r) => ({
                    type: 'resource_link' as const,
                    // Final wave (E1): encoded, because plenty of real ids
                    // contain '/' - every DOI (crossref, datacite,
                    // opencitations), and codewiki/readthedocs' path-shaped
                    // ids - and an unencoded one produced a URI with extra
                    // path segments that resources.ts's {source}/{id}
                    // template could never match back. resources.ts
                    // decodeURIComponent()s it on the way in.
                    uri: `library://doc/${encodeURIComponent(r.source)}/${encodeURIComponent(r.id)}`,
                    name: r.title,
                    title: r.title,
                  }))
              : [];
          return {
            content: [{ type: 'text', text }, ...resourceLinks],
            structuredContent: formatted,
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

  // ── library_read ──────────────────────────────────────────────────────────────
  server.registerTool(
    'library_read',
    {
      title: 'Read Full Text or Metadata',
      description: `Fetch text from a library source. Full-text sources return cleaned text (truncated at 200k chars). Metadata sources return item details and an external URL.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Item identifier from library_search or library_ask'),
        source: SourceSchema,
      }),
      outputSchema: ReadResultSchema,
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
          const raw = await getAdapter(source).read(id);
          const result = await withOpenAccessFallback(raw);
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
      description: `Dry run: fetch text, chunk semantically, score OCR quality. No writes. Full-text sources only.`,
      inputSchema: z.object({ id: z.string().min(1), source: SourceSchema }),
      outputSchema: z.object({
        sourceId: z.string(),
        source: z.string(),
        title: z.string(),
        totalChunks: z.number(),
        droppedChunks: z.number(),
        avgQualityScore: z.number(),
        sampleChunks: z.array(ChunkSchema),
        estimatedTokens: z.number(),
        ingestPolicy: z.enum(['allowed', 'attribution', 'timeboxed', 'forbidden']).optional(),
      }),
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
          const preview = {
            ...indexText(
              result.text,
              source as LibrarySource,
              id,
              result.title,
              result.authors,
              result.year,
              result.language,
            ),
            ingestPolicy: adapter.ingestPolicy ?? 'allowed',
          };
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
      description: `Chunk, embed, and store a text. Idempotent. Full-text sources only. Requires OPENAI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.`,
      inputSchema: z.object({ id: z.string().min(1), source: SourceSchema }),
      outputSchema: z.object({
        sourceId: z.string(),
        source: z.string(),
        title: z.string(),
        chunksWritten: z.number(),
        chunksDropped: z.number(),
        skippedDuplicate: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, source }, ctx) =>
      withRequestContext('library_ingest', async () => {
        try {
          const adapter = getAdapter(source);
          if (!adapter.supportsIngest)
            return {
              content: [{ type: 'text', text: `"${source}" is metadata-only.` }],
              isError: true,
            };
          assertIngestAllowed({
            name: source,
            ingestPolicy: adapter.ingestPolicy,
            homepage: adapter.homepage,
          });
          const result = await adapter.read(id);
          if (!result.text)
            return {
              content: [{ type: 'text', text: `No text for ${source}:${id}` }],
              isError: true,
            };
          const report = progressReporter(server, ctx);
          await report(1, `read "${result.title}"; chunking and embedding`);
          const chunkStamp = ingestMetadata({
            name: source,
            ingestPolicy: adapter.ingestPolicy,
            homepage: adapter.homepage,
          });
          // Review round 1 (Important 1): ReadResult never carries a
          // url/previewUrl/downloadUrl (those are search()'s LibraryResult
          // fields, unavailable here since library_ingest is only given an
          // id) - externalUrl is the one URL-shaped signal read() ever
          // returns, falling back to the source's registry homepage.
          const url = result.externalUrl ?? adapter.homepage;
          const ingestResult = await ingestText(
            result.text,
            source as LibrarySource,
            id,
            result.title,
            result.authors,
            result.year,
            result.language,
            url,
            chunkStamp,
          );
          await report(
            2,
            `ingested chunk batch: ${ingestResult.chunksWritten} written, ${ingestResult.chunksDropped} dropped`,
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
      outputSchema: z.object({ results: z.array(ResultRowSchema) }),
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
      description: `Ask a question in plain English and get a synthesized answer with inline [n] citations, fused across sources with reciprocal rank fusion. Use this instead of library_ask when you want a cited answer rather than raw results. Every factual sentence is cited or dropped; an uncited or all-dropped answer is flagged in warnings[]. Requires OPENAI_API_KEY (or ALEXANDRIA_SYNTH_API_KEY). Set response_format: "detailed" for the full result set, routing, citation grades, and resolvability.`,
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
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({
        answer: z.string(),
        citations: z.array(CitationSchema),
        results: z.array(ResultRowSchema.extend({ score: z.number() })).optional(),
        routing: z.array(RouteItemSchema).optional(),
        warnings: z.array(z.string()).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, max_sources, results_per_source, read_top, response_format }, ctx) =>
      withRequestContext('library_answer', async () => {
        try {
          const report = progressReporter(server, ctx);
          const onProgress: AnswerProgressCallback = (info) =>
            report(ANSWER_STAGE_INDEX[info.stage], info.message);
          const result = await libraryAnswer(
            query,
            {
              maxSources: max_sources,
              resultsPerSource: results_per_source,
              readTop: read_top,
            },
            onProgress,
          );
          const formatted = formatResult('answer', result, response_format);
          return {
            content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
            structuredContent: toStructured(formatted),
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
      description: `Deep research on a topic: outlines 3 to 7 coverage objectives, generates search queries, answers each with library_answer, extracts learnings and follow-up questions, then recurses with half the breadth. Stops once every objective is covered by a learning, at the given depth, at the time budget, or once a round finds no new sources. Requires OPENAI_API_KEY (or ALEXANDRIA_RESEARCH_API_KEY / ALEXANDRIA_SYNTH_API_KEY). Set response_format: "detailed" for the per-round breakdown, elapsed time, citation grades, resolvability, and the objectives/coverage outline.`,
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
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({
        report: z.string(),
        citations: z.array(CitationSchema),
        rounds: z
          .array(
            z.object({
              round: z.number(),
              queries: z.array(z.string()),
              newSources: z.number(),
              truncated: z.boolean(),
            }),
          )
          .optional(),
        elapsedMs: z.number().optional(),
        warnings: z.array(z.string()).optional(),
        objectives: z.array(z.string()).optional(),
        coverage: z.array(z.boolean()).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, depth, breadth, max_minutes, response_format }, ctx) =>
      withRequestContext('library_research', async () => {
        try {
          const report = progressReporter(server, ctx);
          const onProgress: ProgressCallback = (info) => report(info.round, info.message);
          const result = await libraryResearch(
            query,
            { depth, breadth, maxMinutes: max_minutes },
            onProgress,
          );
          const formatted = formatResult('research', result, response_format);
          return {
            content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
            structuredContent: toStructured(formatted),
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

  // ── library_citations ─────────────────────────────────────────────────────────
  server.registerTool(
    'library_citations',
    {
      title: 'Get References or Citations (with Bibliography Export)',
      description: `List the works a scholarly item cites (direction: "references") or the works that cite it (direction: "citations"), resolved through OpenAlex's citation graph with OpenCitations as a fallback when OpenAlex has no record. Accepts an id/source from library_search or library_ask, or a bare DOI/arXiv id. Set format: "bibtex" | "ris" | "apa" to also return a \`formatted\` bibliography string; BibTeX prefers Crossref's own citation when a DOI is resolvable, for the first 20 results only (a paced, one-at-a-time doi.org lookup per item), with later results using a locally generated entry instead. Set response_format: "detailed" for full result fields.`,
      inputSchema: z.object({
        id: z
          .string()
          .min(1)
          .describe('Item identifier from library_search/library_ask, or a bare DOI/arXiv id'),
        source: SourceSchema,
        direction: z
          .enum(['references', 'citations'])
          .describe('references: works this item cites. citations: works that cite this item.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
        format: z
          .enum(['bibtex', 'ris', 'apa'])
          .optional()
          .describe('Also return a `formatted` bibliography string in this style'),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({
        seed: LibraryCitationsSeedSchema,
        direction: z.enum(['references', 'citations']),
        results: z.array(ResultRowSchema),
        formatted: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, source, direction, limit, format, response_format }) =>
      withRequestContext('library_citations', async () => {
        try {
          const result = await libraryCitations({ id, source, direction, limit, format });
          const formatted = formatResult('citations', result, response_format);
          return {
            content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
            structuredContent: toStructured(formatted),
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

  // Task 14: prompts and the `library://doc/{source}/{id}` resource
  // template, registered on the same per-request server as the tools above
  // so both eras get the same surface from one factory.
  registerPrompts(server);
  registerResources(server, withOpenAccessFallback);

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

// Reads req's body up to JSON_BODY_LIMIT_BYTES, mirroring express.json()'s
// size-then-parse behavior.
//
// Final wave, A10: distinguishes the oversize case from any other body-read
// failure so handleMcpRequest's catch below can destroy the request's
// socket - never stopped before - without touching the ordinary error
// path used by every other kind of failure.
class PayloadTooLargeError extends Error {}

// Final wave, B3: an unsupported POST media type is answered here rather
// than by the SDK, which buffers the whole request before deciding.
class UnsupportedMediaTypeError extends Error {}

async function readCappedBody(req: IncomingMessage): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

// A JSON-RPC error envelope under a specific HTTP status, the same body
// shape httpGuards.ts's 403/429 rejections use. Distinct from
// jsonRpcErrorHandler below, which is the catch-all 500 for an unexpected
// throw; these two statuses are deliberate answers, not failures.
function sendJsonRpcStatus(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/**
 * Handle one MCP HTTP request through the dual-era handler (Task 14):
 * `createMcpHandler(factory, { legacy: 'stateless' })` builds a fresh
 * `McpServer` per request either way (2026-07-28 per its own per-request
 * envelope, 2025-era through the same stateless idiom the old hand-wired
 * transport used), so overlapping requests still cannot collide on a single
 * Protocol instance. `mcpHandler` never rejects - `toNodeHandler`'s adapter
 * catches a conversion/`fetch` failure and writes its own 500 - so the
 * try/catch here exists for `readCappedBody`'s cap (below), not the handler
 * itself. Errors are forwarded to the JSON-RPC error handler below rather
 * than leaking an HTML page or a stack trace.
 *
 * Final wave (B3): EVERY POST body is read through the cap first, whatever
 * its content type, and only then checked for a supported media type. The
 * cap used to be gated on isJsonContentType(), so a `Content-Type:
 * text/plain` POST skipped it entirely and the SDK adapter buffered the
 * whole request before answering 415 - a 200 KB text/plain body was
 * accepted in validation against a 100 KiB cap. Reading first is also what
 * makes the oversized case a 413 regardless of type, since the size is
 * known before the media type matters.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mcpHandler: NodeMcpRequestHandler,
): Promise<void> {
  // Captured up front, deliberately not read off `req` later (final wave,
  // A10 review round 2): by the time readCappedBody()'s `for await` throws
  // on an oversize body, Node's async-iterator protocol has already
  // called the stream's own `.return()` as part of unwinding the loop,
  // which destroys `req`'s readable side - so `req.destroyed` is already
  // true by the catch block below, and calling req.destroy() there does
  // NOT tear down the underlying TCP connection (req.socket has already
  // been detached from req by then, so IncomingMessage#destroy() has
  // nothing left to close). The raw net.Socket captured here, before any
  // of that happens, is the one reference still guaranteed connected.
  const sock = req.socket;
  try {
    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readCappedBody(req);
      if (!isJsonContentType(req.headers['content-type'])) {
        throw new UnsupportedMediaTypeError('POST /mcp requires content-type: application/json');
      }
      body = raw.length === 0 ? undefined : JSON.parse(raw.toString('utf8'));
    }
    await mcpHandler(req, res, body);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJsonRpcStatus(res, 413, err.message);
      // Destroying the socket immediately (before the 413 response is
      // flushed) would sever the connection out from under
      // sendJsonRpcStatus's own res.end() above - res 'finish' fires
      // once that response is fully handed off, only then is it safe to
      // stop a peer that was still sending (possibly megabytes) more than
      // this request needed.
      res.on('finish', () => sock?.destroy());
      return;
    }
    if (err instanceof UnsupportedMediaTypeError) {
      sendJsonRpcStatus(res, 415, err.message);
      return;
    }
    jsonRpcErrorHandler(err, res);
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
  // Task 14: one dual-era handler per app (not per request - the handler
  // itself constructs a fresh McpServer per request via `createServer`
  // below). `legacy: 'stateless'` keeps serving 2025-era traffic exactly as
  // the hand-wired NodeStreamableHTTPServerTransport it replaces did; a
  // 2026-07-28 `server/discover` probe or per-request envelope now also
  // succeeds against the same endpoint.
  const mcpHandler = createMcpHandler((_ctx) => createServer(), {
    legacy: 'stateless',
    onerror: (err) => log.error({ err: err.message }, 'mcp handler error'),
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler);

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
        // Task 13: Host/Origin validation (DNS-rebinding protection) and a
        // per-client-IP rate limit, both applied before this request ever
        // reaches the MCP transport. Each guard has already written its
        // own rejection response when it returns false - nothing left to
        // do here but stop.
        if (!checkOrigin(req, res)) return;
        if (!checkRateLimit(req, res)) return;
        void handleMcpRequest(req, res, nodeMcpHandler);
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
  // Final wave (B1): with no allowlist there is nothing to validate the
  // Host header against, so that guard is off entirely and this deployment
  // has no DNS-rebinding protection. That is the deliberate default (the
  // alternative, applying it anyway, 403s every request to any deployment
  // that has not set the variable), but it must never be a silent one.
  if (configuredOriginHostnames().length === 0) {
    log.warn(
      {},
      "ALEXANDRIA_ALLOWED_ORIGINS is not set: Host-header (DNS-rebinding) validation is OFF for /mcp. Set it to this deployment's hostname(s) to turn it on. The Origin check still applies to any request carrying an Origin header.",
    );
  }
  httpServer.listen(port, () =>
    log.info(
      { sources: listSources().length, url: `http://localhost:${port}/mcp` },
      'alexandria started',
    ),
  );
}

// Task 14: `serveStdio` owns the era decision for the connection - the
// opening exchange (a 2026-07-28 `server/discover` probe or a 2025-era
// `initialize`) selects it, and one `createServer()` instance is pinned for
// the connection's lifetime, same as the hand-wired
// `server.connect(new StdioServerTransport())` this replaces did for the
// single 2025-era session it could ever serve.
async function runStdio(): Promise<void> {
  serveStdio(() => createServer());
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
