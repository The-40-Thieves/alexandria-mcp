import { config } from '../config.ts';
import type { IngestMetadata } from '../sources/ingestPolicy.ts';
import { listSources } from '../sources/registry.ts';
import type {
  Chunk,
  ChunkMetadata,
  EmbeddingProvider,
  IndexPreview,
  IngestResult,
  LibrarySource,
  VectorStoreProvider,
} from '../types.ts';
import {
  buildEmbeddingProvider,
  buildVectorStoreProvider,
  resolveConfig,
} from './providers/index.ts';
import { avgQuality, filterChunks, scoreChunk } from './quality.ts';

const TARGET_CHUNK_WORDS = 350;
const MCP_NAME_PREFIX = 'library';

// ─── Semantic chunking ─────────────────────────────────────────────────────
// Split text at paragraph boundaries first. If a paragraph is longer than
// TARGET_CHUNK_WORDS, split at sentence boundaries. Heading lines (all caps,
// numbered, or prefixed with #) are attached to the next chunk as metadata.

const HEADING_RE = /^(#{1,6}\s.+|[A-Z][A-Z\s]{4,}|Chapter\s+\w+|CHAPTER\s+\w+|\d+\.\s+[A-Z].+)$/;

function detectHeading(line: string): string | null {
  return HEADING_RE.test(line.trim()) ? line.trim() : null;
}

const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+)$/;

interface PendingChunk {
  text: string;
  // The single nearest heading (any style: markdown, ALL CAPS, "Chapter
  // N", numbered) - metadata.section's value, same meaning as before.
  section: string;
  // The nesting path down to the nearest heading, markdown '#' levels
  // only: e.g. a chunk under "## Section A" inside "# Chapter One" gets
  // ['Chapter One', 'Section A']. A non-markdown heading has no nesting
  // information, so it resets this to just itself.
  headingChain: string[];
}

export function chunkSemantic(
  text: string,
  metadata: Omit<ChunkMetadata, 'chunkIndex' | 'totalChunks' | 'qualityScore' | 'section'>,
): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: PendingChunk[] = [];

  let currentWords = 0;
  let currentText = '';
  let currentSection = '';
  // Stack of markdown '#'-heading text, indexed by level (0 = '#', 1 =
  // '##', ...), truncated on every new heading to whatever level it's at
  // so the stack always reflects the live path down to the last heading.
  let headingStack: string[] = [];

  const flush = () => {
    if (!currentText.trim()) return;
    chunks.push({
      text: currentText.trim(),
      section: currentSection,
      headingChain: headingStack.filter(Boolean),
    });
    currentText = '';
    currentWords = 0;
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const heading = detectHeading(trimmed);
    if (heading) {
      const md = heading.match(MARKDOWN_HEADING_RE);
      if (md) {
        const level = md[1].length - 1;
        headingStack = headingStack.slice(0, level);
        headingStack[level] = md[2].trim();
      } else {
        headingStack = [heading];
      }
      currentSection = heading;
      continue;
    }

    const wordCount = trimmed.split(/\s+/).length;

    if (currentWords + wordCount > TARGET_CHUNK_WORDS && currentText) {
      flush();
    }

    currentText += (currentText ? '\n\n' : '') + trimmed;
    currentWords += wordCount;
  }

  flush();

  // Task 11 (brief 07): prepend the source title and the nearest heading
  // chain to each chunk's *embedded* text (Chunk.embedText), leaving the
  // stored/displayed `text` untouched - free context for the embedding
  // model that a bare 350-word chunk doesn't otherwise carry (see
  // research/retrieval-sota.md section 5's "title-chain prefix" note).
  // ALEXANDRIA_CHUNK_PREFIX=off turns this back off.
  const prefixEnabled = config.ALEXANDRIA_CHUNK_PREFIX !== 'off';

  return chunks.map((c, i) => {
    const chunk: Chunk = {
      text: c.text,
      metadata: {
        ...metadata,
        section: c.section || undefined,
        chunkIndex: i,
        totalChunks: chunks.length,
        qualityScore: 0, // filled by scoreChunk
      },
    };

    if (prefixEnabled) {
      const prefix = [metadata.title, ...c.headingChain].filter(Boolean).join(' > ');
      if (prefix) chunk.embedText = `${prefix}\n\n${c.text}`;
    }

    return scoreChunk(chunk);
  });
}

// ─── Index (dry run) ───────────────────────────────────────────────────────

export function indexText(
  text: string,
  source: LibrarySource,
  sourceId: string,
  title: string,
  authors: string[],
  year?: number,
  language?: string,
): IndexPreview {
  const raw = chunkSemantic(text, {
    source,
    sourceId,
    title,
    authors,
    year,
    language,
  });

  const { passed, dropped } = filterChunks(raw);
  // Review round 1 (Minor): estimate against what actually gets embedded
  // (embedText, when the title/heading-chain prefix is on) rather than
  // the shorter displayed text, so this dry-run preview isn't an
  // undercount of the real embedding call's token volume.
  const estimatedTokens = passed.reduce(
    (sum, c) => sum + Math.ceil((c.embedText ?? c.text).length / 4),
    0,
  );

  return {
    sourceId,
    source,
    title,
    totalChunks: passed.length,
    droppedChunks: dropped,
    avgQualityScore: avgQuality(passed),
    sampleChunks: passed.slice(0, 3),
    estimatedTokens,
  };
}

// ─── Ingest ────────────────────────────────────────────────────────────────

export async function ingestText(
  text: string,
  source: LibrarySource,
  sourceId: string,
  title: string,
  authors: string[],
  year?: number,
  language?: string,
  // Review round 1 (Important 1): the best link available at read time for
  // this document (the adapter's ReadResult.externalUrl, falling back to
  // the source's registry homepage - see src/index.ts's library_ingest
  // handler), stamped onto every chunk's metadata.url so a corpus-as-cache
  // citation (src/pipeline/corpusSearch.ts) has a real URL instead of none.
  url?: string,
  // The ingest-policy stamp (src/sources/ingestPolicy.ts's ingestMetadata())
  // to merge onto every chunk's metadata before it's embedded and written,
  // so license/attribution/an expiry survive alongside the chunk in the
  // vector store. Undefined (the 'allowed' policy's stamp) merges nothing.
  chunkStamp?: IngestMetadata,
  // Test-only injection point: a caller (ingestPolicy.test.ts-adjacent
  // pipeline tests) can pass a fake embedder/store instead of the real
  // OpenAI/Supabase ones resolveConfig() would otherwise build.
  providers?: { embedder?: EmbeddingProvider; store?: VectorStoreProvider },
): Promise<IngestResult> {
  const config = resolveConfig();
  const embedder = providers?.embedder ?? (await buildEmbeddingProvider(config.embedding));
  const store = providers?.store ?? (await buildVectorStoreProvider(config.vectorStore));

  const mcpName = `${MCP_NAME_PREFIX}-${source}`;

  // Dedup check
  const duplicate = await store.isDuplicate(sourceId, mcpName);
  if (duplicate) {
    return {
      sourceId,
      source,
      title,
      chunksWritten: 0,
      chunksDropped: 0,
      skippedDuplicate: true,
    };
  }

  // Review round 1 (Important 1): the cluster a corpus-as-cache citation
  // needs for the grader (src/utils/citationGrade.ts) comes from the
  // registry's SourceMeta at ingest time, not from a caller-supplied value
  // - there's exactly one source of truth for a source's cluster.
  const cluster = listSources().find((s) => s.name === source)?.cluster;

  const raw = chunkSemantic(text, {
    source,
    sourceId,
    title,
    authors,
    year,
    language,
    url,
    cluster,
  });

  const stamped = chunkStamp
    ? raw.map((c) => ({ ...c, metadata: { ...c.metadata, ...chunkStamp } }))
    : raw;

  const { passed, dropped } = filterChunks(stamped);

  if (passed.length === 0) {
    return {
      sourceId,
      source,
      title,
      chunksWritten: 0,
      chunksDropped: dropped,
      skippedDuplicate: false,
    };
  }

  // Task 11: embed embedText (title + heading-chain prefix) when present,
  // but store/display c.text - see Chunk.embedText's doc comment.
  const embeddings = await embedder.embed(passed.map((c) => c.embedText ?? c.text));
  const written = await store.upsert(passed, embeddings, mcpName);

  return {
    sourceId,
    source,
    title,
    chunksWritten: written,
    chunksDropped: dropped,
    skippedDuplicate: false,
  };
}
