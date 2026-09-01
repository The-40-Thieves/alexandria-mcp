import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { indexText, ingestText } from './pipeline/index.js';
import { getAdapter, listSources } from './sources/registry.js';
import { s2Recommend } from './sources/semanticscholar.js';
import { libraryAsk } from './tools/libraryAsk.js';
import type { LibrarySource } from './types.js';

import './sources/all.js';

const server = new McpServer({ name: 'alexandria', version: '9.2.0' });

const SourceSchema = z
  .string()
  .describe('Library source name. Run library_list_sources for the current list and descriptions.');
function toStructured(val: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(val)) as Record<string, unknown>;
}

// ── library_list_sources ─────────────────────────────────────────────────────
server.registerTool(
  'library_list_sources',
  {
    title: 'List Available Library Sources',
    description: `List all ${listSources().length} library sources with descriptions and capabilities.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const sources = listSources();
    const text = sources
      .map(
        (s) =>
          `${s.name} [${s.kind}/${s.cluster}] [${s.supportsIngest ? 'full text' : 'metadata'}]: ${s.description}`,
      )
      .join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { sources } };
  },
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
Returns: { query, intent, sources_searched, total_results, results[], routing[], errors[] }`,
    inputSchema: {
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
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ query, max_sources, results_per_source }) => {
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
  },
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
    inputSchema: {
      query: z.string().min(1).max(300).describe('Title, author, subject, or keywords'),
      source: SourceSchema,
      limit: z.number().int().min(1).max(20).default(10).describe('Max results'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, source, limit }) => {
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
  },
);

// ── library_read ──────────────────────────────────────────────────────────────
server.registerTool(
  'library_read',
  {
    title: 'Read Full Text or Metadata',
    description: `Fetch text from a library source. Full-text sources return cleaned text (truncated at 200k chars). Metadata sources return item details and an external URL.

Returns: { title, authors, year?, language?, text?, charCount?, truncated?, metadataOnly?, externalUrl?, note? }`,
    inputSchema: {
      id: z.string().min(1).describe('Item identifier from library_search or library_ask'),
      source: SourceSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id, source }) => {
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
  },
);

// ── library_index ─────────────────────────────────────────────────────────────
server.registerTool(
  'library_index',
  {
    title: 'Preview Chunking (Dry Run)',
    description: `Dry run: fetch text, chunk semantically, score OCR quality. No writes. Full-text sources only.
Returns: { totalChunks, droppedChunks, avgQualityScore, estimatedTokens, sampleChunks[0..2] }`,
    inputSchema: { id: z.string().min(1), source: SourceSchema },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id, source }) => {
    try {
      const adapter = getAdapter(source);
      if (!adapter.supportsIngest)
        return {
          content: [{ type: 'text', text: `"${source}" is metadata-only.` }],
          isError: true,
        };
      const result = await adapter.read(id);
      if (!result.text)
        return { content: [{ type: 'text', text: `No text for ${source}:${id}` }], isError: true };
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
  },
);

// ── library_ingest ────────────────────────────────────────────────────────────
server.registerTool(
  'library_ingest',
  {
    title: 'Ingest Into Vector Database',
    description: `Chunk, embed, and store a text. Idempotent. Full-text sources only. Requires OPENAI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
Returns: { chunksWritten, chunksDropped, skippedDuplicate, title, sourceId }`,
    inputSchema: { id: z.string().min(1), source: SourceSchema },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id, source }) => {
    try {
      const adapter = getAdapter(source);
      if (!adapter.supportsIngest)
        return {
          content: [{ type: 'text', text: `"${source}" is metadata-only.` }],
          isError: true,
        };
      const result = await adapter.read(id);
      if (!result.text)
        return { content: [{ type: 'text', text: `No text for ${source}:${id}` }], isError: true };
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
  },
);

// ── library_recommend ─────────────────────────────────────────────────────────
server.registerTool(
  'library_recommend',
  {
    title: 'Get Similar Papers (Semantic Scholar)',
    description: `Get papers similar to a given paper using Semantic Scholar's recommendation engine. Pass a paperId from a semanticscholar search result. Returns up to 500 similar papers.`,
    inputSchema: {
      id: z.string().min(1).describe('Semantic Scholar paperId'),
      limit: z.number().int().min(1).max(500).default(20),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id, limit }) => {
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
  },
);

// ── HTTP / stdio transport ────────────────────────────────────────────────────
async function handleMcpRequest(req: express.Request, res: express.Response): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post('/mcp', handleMcpRequest);
  app.get('/mcp', handleMcpRequest);
  app.delete('/mcp', handleMcpRequest);
  app.get('/health', (_req, res) => res.json({ status: 'ok', sources: listSources().length }));
  const port = parseInt(process.env.PORT ?? '3000', 10);
  app.listen(port, () =>
    console.error(`alexandria — ${listSources().length} sources — http://localhost:${port}/mcp`),
  );
}

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`alexandria — ${listSources().length} sources`);
}

const transportMode = process.env.TRANSPORT ?? 'stdio';
if (transportMode === 'http') {
  runHTTP().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
