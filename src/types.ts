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
  cluster?: string; // set by libraryAsk's fan-out from the source's registry.ts cluster
}

export interface Chunk {
  text: string;
  // Task 11 (brief 07): what actually gets embedded, when it differs from
  // `text`. chunkSemantic() prepends the source title and its nearest
  // markdown heading chain here to give the embedding model context a bare
  // 350-word chunk doesn't carry on its own; `text` stays the raw chunk so
  // storage/display/quality-scoring never show a reader a prefix they
  // didn't write. Absent (ALEXANDRIA_CHUNK_PREFIX=off, or nothing to
  // prepend) means embed `text` itself, same as before this field existed.
  embedText?: string;
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
  // Stamped by ingestText() from the source's ingestPolicy (see
  // src/sources/ingestPolicy.ts's ingestMetadata()) so provenance and any
  // retention deadline survive alongside the chunk in the vector store.
  license?: string;
  attribution?: string;
  expiresAt?: string;
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
  // The source's ingest policy (src/sources/ingestPolicy.ts), so a caller
  // previewing an ingest can see up front whether library_ingest will
  // refuse it or stamp attribution/expiry. Set by the library_index tool
  // handler, not by indexText() itself (this is registry data, not
  // something the text-chunking pipeline knows about).
  ingestPolicy?: 'allowed' | 'attribution' | 'timeboxed' | 'forbidden';
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
  // Task 6: an adapter-provided DOI, read by library_read's handler
  // (src/index.ts) to drive the open-access fallback chain
  // (src/web/openAccess.ts) when metadataOnly is true and this field (or
  // one embedded in externalUrl) is present.
  doi?: string;
  // Page anchors into `text`, set only when the text came from a PDF
  // (src/web/pdf.ts via src/web/fetchTier.ts's 'pdf' tier). charStart/
  // charEnd are character offsets into the untruncated `text` (before
  // truncateText() slices it for the 200k-char cap), so they stay valid
  // even when `truncated` is true - a consumer just won't have the tail
  // pages' text.
  pages?: { page: number; charStart: number; charEnd: number }[];
  // Set instead of `text` when library_read's open-access fallback chain
  // could not produce any full text - never an empty `text` string.
  unavailable?: {
    reason: 'no_full_text' | 'paywalled' | 'not_found' | 'too_large' | 'blocked';
    triedTiers: string[];
  };
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorStoreProvider {
  upsert(chunks: Chunk[], embeddings: number[][], mcpName: string): Promise<number>;
  isDuplicate(sourceId: string, mcpName: string): Promise<boolean>;
}
