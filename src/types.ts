export type LibrarySource =
  | 'gutenberg' | 'openlibrary' | 'archive' | 'sacredtexts'
  | 'wikisource' | 'standardebooks' | 'perseus' | 'ctext'
  | 'loc' | 'hathitrust' | 'dpla' | 'ndl'
  | 'gallica' | 'europeana' | 'trove' | 'bhl' | 'digitalnz'
  | 'internetclassics' | 'marxists' | 'projectruneberg' | 'cervantes'
  | 'doab' | 'oapen' | 'googlebooks' | 'chroniclingamerica'
  | 'ccel' | 'feedbooks' | 'wdl' | 'datagov'
  | 'arxiv' | 'core' | 'europmc' | 'nasa' | 'osti'
  | 'eric' | 'nsf' | 'courtlistener' | 'biorxiv' | 'zenodo' | 'semanticscholar'
  | 'govinfo' | 'nih' | 'nbnorway' | 'legislation' | 'osf'
  | 'earlyprint' | 'openiti' | 'legislationscot'
  | 'openalex' | 'plos' | 'crossref' | 'nasaads' | 'smithsonian' | 'doaj' | 'nara' | 'springer'
  | 'harvardlib' | 'apollo' | 'ora' | 'base'
  | 'codewiki';

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
