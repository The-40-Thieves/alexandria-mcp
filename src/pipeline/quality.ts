import { ocrQualityScore } from '../utils/text-clean.js';
import type { Chunk } from '../types.js';

// Chunks below this threshold are dropped before ingestion.
// 0.75 means at least 75% of characters must be "clean".
export const DEFAULT_QUALITY_THRESHOLD = 0.75;

// Minimum chunk length in characters to be worth ingesting.
export const MIN_CHUNK_LENGTH = 100;

export function scoreChunk(chunk: Chunk): Chunk {
  return {
    ...chunk,
    metadata: {
      ...chunk.metadata,
      qualityScore: ocrQualityScore(chunk.text),
    },
  };
}

export function filterChunks(
  chunks: Chunk[],
  threshold = DEFAULT_QUALITY_THRESHOLD
): { passed: Chunk[]; dropped: number } {
  const passed: Chunk[] = [];
  let dropped = 0;

  for (const chunk of chunks) {
    if (
      chunk.text.length < MIN_CHUNK_LENGTH ||
      chunk.metadata.qualityScore < threshold
    ) {
      dropped++;
    } else {
      passed.push(chunk);
    }
  }

  return { passed, dropped };
}

export function avgQuality(chunks: Chunk[]): number {
  if (chunks.length === 0) return 0;
  const total = chunks.reduce((sum, c) => sum + c.metadata.qualityScore, 0);
  return total / chunks.length;
}
