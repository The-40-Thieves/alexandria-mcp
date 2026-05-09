import OpenAI from 'openai';
import type { EmbeddingProvider } from '../../types.js';

const BATCH_SIZE = 100; // OpenAI recommends batching

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536;

  private client: OpenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });

      for (const item of response.data) {
        results.push(item.embedding);
      }
    }

    return results;
  }
}
