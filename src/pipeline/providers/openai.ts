import type { EmbeddingProvider } from '../../types.js';
import { embed } from '../../utils/providers.js';

// Thin wrapper over the shared per-role provider table (THE-318): batching
// and the embeddings role's config resolution (OPENAI_API_KEY or
// ALEXANDRIA_EMBEDDINGS_*/ALEXANDRIA_*) now live in src/utils/providers.ts.
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536; // text-embedding-3-small's default output size

  async embed(texts: string[]): Promise<number[][]> {
    return embed(texts);
  }
}
