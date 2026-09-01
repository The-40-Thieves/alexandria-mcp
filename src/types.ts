// A source is any name registered in src/sources/registry.ts. It was a
// closed union in v1; v2's registry is the source of truth for which names
// exist, so this widens to string and callers validate via getAdapter().
export type LibrarySource = string;

export interface LibraryResult {
  id: string;
  source: LibrarySource;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  subjects?: string[];
  hasFullText: boolean;
  previewUrl?: string;
  downloadUrl?: string;
  description?: string;
  published?: string;
  url?: string;
}

export interface Chunk {
  text: string;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  source: LibrarySource;
  sourceId: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  section?: string;
  chunkIndex: number;
  totalChunks: number;
  qualityScore: number;
}

export interface IndexPreview {
  sourceId: string;
  source: LibrarySource;
  title: string;
  totalChunks: number;
  droppedChunks: number;
  avgQualityScore: number;
  sampleChunks: Chunk[];
  estimatedTokens: number;
}

export interface IngestResult {
  sourceId: string;
  source: LibrarySource;
  title: string;
  chunksWritten: number;
  chunksDropped: number;
  skippedDuplicate: boolean;
}

export interface ReadResult {
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  text?: string;
  charCount?: number;
  truncated?: boolean;
  truncatedAt?: number;
  metadataOnly?: boolean;
  externalUrl?: string;
  note?: string;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorStoreProvider {
  upsert(chunks: Chunk[], embeddings: number[][], mcpName: string): Promise<number>;
  isDuplicate(sourceId: string, mcpName: string): Promise<boolean>;
}
