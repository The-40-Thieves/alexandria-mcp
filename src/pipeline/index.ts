import type { Chunk, ChunkMetadata, IndexPreview, IngestResult } from '../types.js';
import type { LibrarySource } from '../types.js';
import { scoreChunk, filterChunks, avgQuality } from './quality.js';
import {
  resolveConfig,
  buildEmbeddingProvider,
  buildVectorStoreProvider,
} from './providers/index.js';

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

export function chunkSemantic(
  text: string,
  metadata: Omit<ChunkMetadata, 'chunkIndex' | 'totalChunks' | 'qualityScore' | 'section'>
): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Omit<Chunk, 'metadata'>[] = [];
  const sections: string[] = [];

  let currentWords = 0;
  let currentText = '';
  let currentSection = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const heading = detectHeading(trimmed);
    if (heading) {
      currentSection = heading;
      sections.push(heading);
      continue;
    }

    const wordCount = trimmed.split(/\s+/).length;

    if (currentWords + wordCount > TARGET_CHUNK_WORDS && currentText) {
      chunks.push({ text: currentText.trim() });
      currentText = '';
      currentWords = 0;
    }

    currentText += (currentText ? '\n\n' : '') + trimmed;
    currentWords += wordCount;
  }

  if (currentText.trim()) {
    chunks.push({ text: currentText.trim() });
  }

  // Build final Chunk[] with section metadata
  // We track which section each chunk falls under using a simple cursor
  let sectionCursor = '';
  let sectionIdx = 0;

  return chunks.map((c, i) => {
    // Advance section cursor if this chunk contains a section transition
    if (sectionIdx < sections.length) {
      const sectionText = sections[sectionIdx];
      if (c.text.includes(sectionText.replace(/^#+\s/, '').substring(0, 20))) {
        sectionCursor = sectionText;
        sectionIdx++;
      }
    }

    const chunk: Chunk = {
      text: c.text,
      metadata: {
        ...metadata,
        section: sectionCursor || undefined,
        chunkIndex: i,
        totalChunks: chunks.length,
        qualityScore: 0, // filled by scoreChunk
      },
    };

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
  language?: string
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
  const estimatedTokens = passed.reduce(
    (sum, c) => sum + Math.ceil(c.text.length / 4),
    0
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
  language?: string
): Promise<IngestResult> {
  const config = resolveConfig();
  const embedder = await buildEmbeddingProvider(config.embedding);
  const store = await buildVectorStoreProvider(config.vectorStore);

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

  const raw = chunkSemantic(text, {
    source,
    sourceId,
    title,
    authors,
    year,
    language,
  });

  const { passed, dropped } = filterChunks(raw);

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

  const embeddings = await embedder.embed(passed.map(c => c.text));
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
