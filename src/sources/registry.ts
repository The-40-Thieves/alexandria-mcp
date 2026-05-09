import type { LibraryResult, ReadResult } from '../types.js';

export interface SourceAdapter {
  description: string;
  supportsIngest: boolean;   // does this source have retrievable plain text?
  search(query: string, limit: number): Promise<LibraryResult[]>;
  read(id: string): Promise<ReadResult>;
}

const REGISTRY = new Map<string, SourceAdapter>();

export function register(name: string, adapter: SourceAdapter): void {
  REGISTRY.set(name, adapter);
}

export function getAdapter(name: string): SourceAdapter {
  const adapter = REGISTRY.get(name);
  if (!adapter) {
    const available = [...REGISTRY.keys()].sort().join(', ');
    throw new Error(
      `Unknown source: "${name}". ` +
      `Available sources: ${available}`
    );
  }
  return adapter;
}

export function listSources(): Array<{ name: string; description: string; supportsIngest: boolean }> {
  return [...REGISTRY.entries()].map(([name, adapter]) => ({
    name,
    description: adapter.description,
    supportsIngest: adapter.supportsIngest,
  }));
}

// ─── Max chars for library_read ────────────────────────────────────────────
export const READ_MAX_CHARS = 200_000;

export function truncateText(text: string): {
  text: string;
  charCount: number;
  truncated: boolean;
  truncatedAt?: number;
} {
  const charCount = text.length;
  const truncated = charCount > READ_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, READ_MAX_CHARS) : text,
    charCount,
    truncated,
    truncatedAt: truncated ? READ_MAX_CHARS : undefined,
  };
}
