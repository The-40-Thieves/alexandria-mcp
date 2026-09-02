import type { EmbeddingProvider, VectorStoreProvider } from '../../types.ts';

export type { EmbeddingProvider, VectorStoreProvider };

export type EmbeddingProviderName = 'openai';
export type VectorStoreProviderName = 'supabase';

export interface ProviderConfig {
  embedding: EmbeddingProviderName;
  vectorStore: VectorStoreProviderName;
}

export function resolveConfig(): ProviderConfig {
  return {
    embedding: (process.env.EMBEDDING_PROVIDER as EmbeddingProviderName) || 'openai',
    vectorStore: (process.env.VECTOR_STORE_PROVIDER as VectorStoreProviderName) || 'supabase',
  };
}

export async function buildEmbeddingProvider(
  name: EmbeddingProviderName,
): Promise<EmbeddingProvider> {
  switch (name) {
    case 'openai': {
      const { OpenAIEmbeddingProvider } = await import('./openai.ts');
      return new OpenAIEmbeddingProvider();
    }
    default:
      throw new Error(
        `Unknown embedding provider: "${name}". ` +
          `Set EMBEDDING_PROVIDER to one of: openai. ` +
          `To add a new provider, implement EmbeddingProvider and register it here.`,
      );
  }
}

export async function buildVectorStoreProvider(
  name: VectorStoreProviderName,
): Promise<VectorStoreProvider> {
  switch (name) {
    case 'supabase': {
      const { SupabaseVectorStoreProvider } = await import('./supabase.ts');
      return new SupabaseVectorStoreProvider();
    }
    default:
      throw new Error(
        `Unknown vector store provider: "${name}". ` +
          `Set VECTOR_STORE_PROVIDER to one of: supabase. ` +
          `To add a new provider, implement VectorStoreProvider and register it here.`,
      );
  }
}
