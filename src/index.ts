import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isJsonContentType, McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { config, loadConfig } from './config.ts';
import { buildInstructions } from './instructions.ts';
import { log, requestLogger } from './log.ts';
import { indexText, ingestText } from './pipeline/index.ts';
import { assertIngestAllowed, ingestMetadata } from './sources/ingestPolicy.ts';
import { getAdapter, healthSummary, listSources, truncateText } from './sources/registry.ts';
import { s2Recommend } from './sources/semanticscholar.ts';
import { TOOL_COUNT } from './toolCount.ts';
import { formatResult } from './tools/format.ts';
import {
  type AnswerProgressCallback,
  type AnswerProgressInfo,
  libraryAnswer,
} from './tools/libraryAnswer.ts';
import { libraryAsk } from './tools/libraryAsk.ts';
import { libraryHealth } from './tools/libraryHealth.ts';
import { libraryResearch, type ProgressCallback } from './tools/libraryResearch.ts';
import type { LibrarySource, ReadResult } from './types.ts';
import { closeDispatchers, installDispatcher } from './utils/dispatcher.ts';
import { requestContext } from './utils/http.ts';
import { metricsSnapshot, sourceCallTotals, toolMetrics } from './utils/metrics.ts';
import { closeStateStore } from './utils/stateStore.ts';
import { VERSION } from './version.ts';
import { type FetchedPage, fetchAsText } from './web/fetchTier.ts';
import {
  extractDoiFromUrl,
  fetchBiocFullText,
  OPEN_ACCESS_HOP_ORDER,
  OpenAccessBlockedError,
  pmcidFromBiocUrl,
  resolveOpenAccess,
} from './web/openAccess.ts';
import { PDF_PAGE_JOINER } from './web/pdf.ts';

import './sources/all.ts';

// The ten public tools registered below (library_list_sources, library_ask,
// library_search, library_read, library_index, library_ingest,
// library_recommend, library_answer, library_research,
// library_health_check). TOOL_COUNT itself lives in src/toolCount.ts, not
// here, so scripts/gen-docs.ts's README /health example can read the same
// value instead of carrying its own separate literal (task 2 review
// finding: those two drifted).

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
});

const ChunkSchema = z.object({ text: z.string(), metadata: ChunkMetadataSchema });

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

// Task 6 (and review round 1's controller ruling): the open-access
// fallback chain, used by library_read's handler below. Triggers whenever
// an adapter's result has no full text - metadataOnly: true, OR less than
// MIN_FULL_TEXT_CHARS of `text` (most scholarly adapters - crossref,
// datacite, biorxiv, medrxiv, plos, doaj, europmc, zenodo, osf, openalex,
// semanticscholar - never set metadataOnly at all; read() just returns an
// abstract stub as `text`) - AND the item names a DOI, its own `doi`
// field, or one embedded in `externalUrl`. resolveOpenAccess() (openalex,
// pmc, core, fatcat, in that order) finds a candidate URL, then this
// fetches it (fetchAsText for a PDF/HTML candidate, fetchBiocFullText
// directly for a PMC one, since PMC's BioC endpoint is neither HTML nor a
// PDF and fetchAsText's content-type gate would refuse it). On success the
// adapter's own stub moves to `note` (dropped only when it's identical to
// the new full text) rather than being discarded. Anything short of real
// text keeps the adapter's original `text` untouched (never blanked) and
// attaches `unavailable` with a reason and which OA sources were actually
// tried.
const MIN_FULL_TEXT_CHARS = 2000;

type UnavailableReason = NonNullable<ReadResult['unavailable']>['reason'];

function classifyOpenAccessFailure(err: unknown): UnavailableReason {
  const message = err instanceof Error ? err.message : String(err);
  // fetchTier.ts's guard errors ("fetchAsText: refusing to fetch ...",
  // "fetchAsText: could not resolve ...", "fetchAsText: not a valid
  // URL ...") all start this way - see assertFetchableUrl's callers.
  if (/refusing to fetch|could not resolve|not a valid URL/.test(message)) return 'blocked';
  if (/byte cap/.test(message)) return 'too_large'; // readCappedBytes/readCappedText
  if (/HTTP 40[123]\b/.test(message)) return 'paywalled';
  return 'no_full_text';
}

// Mirrors pdf.ts's extractPdf(): `text` is these pages' text joined by
// PDF_PAGE_JOINER, so walking the same join recovers each page's char
// range in that (untruncated) text.
function pdfPagesToCharPages(
  pages: NonNullable<FetchedPage['pages']>,
): NonNullable<ReadResult['pages']> {
  let offset = 0;
  return pages.map(({ page, text }) => {
    const charStart = offset;
    const charEnd = charStart + text.length;
    offset = charEnd + PDF_PAGE_JOINER.length;
    return { page, charStart, charEnd };
  });
}

function hasFullText(result: ReadResult): boolean {
  return !result.metadataOnly && (result.text ?? '').length >= MIN_FULL_TEXT_CHARS;
}

async function withOpenAccessFallback(result: ReadResult): Promise<ReadResult> {
  if (hasFullText(result)) return result;
  const doi = result.doi ?? extractDoiFromUrl(result.externalUrl);
  if (!doi) return result;

  const allHops = [...OPEN_ACCESS_HOP_ORDER] as string[];
  let oa: Awaited<ReturnType<typeof resolveOpenAccess>>;
  try {
    oa = await resolveOpenAccess(doi);
  } catch (err) {
    // A hop's own candidate URL was refused by assertFetchableUrl (see
    // openAccess.ts's module comment) - a real refusal, not "nothing
    // found", so it's reported rather than silently swallowed.
    // OpenAccessBlockedError carries exactly the hops resolveOpenAccess
    // attempted before the one that threw; anything else (a bug, an
    // unexpected throw) falls back to reporting the full hop list.
    const triedTiers = err instanceof OpenAccessBlockedError ? err.tried : allHops;
    return { ...result, unavailable: { reason: classifyOpenAccessFailure(err), triedTiers } };
  }
  if (!oa) {
    return { ...result, unavailable: { reason: 'not_found', triedTiers: allHops } };
  }

  const triedTiers = allHops.slice(0, allHops.indexOf(oa.via) + 1);
  try {
    let text: string;
    let title = result.title;
    let pages: NonNullable<ReadResult['pages']> | undefined;
    if (oa.via === 'pmc') {
      const pmcid = pmcidFromBiocUrl(oa.url);
      const fetched = pmcid ? await fetchBiocFullText(pmcid) : undefined;
      if (!fetched) throw new Error(`no BioC full text available at ${oa.url}`);
      text = fetched;
    } else {
      const page = await fetchAsText(oa.url);
      if (!page.text) throw new Error(`empty text fetching ${oa.url}`);
      text = page.text;
      title = result.title || page.title;
      if (page.via === 'pdf' && page.pages) pages = pdfPagesToCharPages(page.pages);
    }
    const enriched: ReadResult = { ...result, metadataOnly: false, title, ...truncateText(text) };
    if (pages) enriched.pages = pages;
    // The adapter's own abstract/stub is kept under `note` rather than
    // discarded - a short-text trigger means the adapter DID return
    // something real, just not full text.
    if (result.text && result.text !== text) {
      enriched.note = result.note
        ? `${result.note}\n\nAbstract: ${result.text}`
        : `Abstract: ${result.text}`;
    }
    return enriched;
  } catch (err) {
    // Keep the adapter's own text untouched (never blanked); only attach
    // `unavailable` (result is spread first, so its `text` survives).
    return { ...result, unavailable: { reason: classifyOpenAccessFailure(err), triedTiers } };
  }
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
      description: `Report per-source health: 'ok', 'degraded', 'down', 'key_missing', or 'unknown', merging this process's live error rate and latency with the last off-process probe run. Use before relying on a source that has been erroring, or to check whether a key is configured. Optionally filter by source or cluster. Set response_format: "detailed" for error rate, latency, and quota usage.`,
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
        const result = libraryHealth({ source, cluster, response_format });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: toStructured(result),
        };
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
          return { content: [{ type: 'text', text }], structuredContent: formatted };
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
          const ingestResult = await ingestText(
            result.text,
            source as LibrarySource,
            id,
            result.title,
            result.authors,
            result.year,
            result.language,
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
      description: `Ask a question in plain English and get a synthesized answer with inline [n] citations, fused across sources with reciprocal rank fusion. Use this instead of library_ask when you want a cited answer rather than raw results. Every factual sentence is cited or dropped; an uncited or all-dropped answer is flagged in warnings[]. Requires OPENAI_API_KEY (or ALEXANDRIA_SYNTH_API_KEY). Set response_format: "detailed" for the full result set, routing, and warnings.`,
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
      description: `Deep research on a topic: generates search queries, answers each with library_answer, extracts learnings and follow-up questions, then recurses with half the breadth. Stops at the given depth, the time budget, or once a round finds no new sources. Requires OPENAI_API_KEY (or ALEXANDRIA_RESEARCH_API_KEY / ALEXANDRIA_SYNTH_API_KEY). Set response_format: "detailed" for the per-round breakdown and elapsed time.`,
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
