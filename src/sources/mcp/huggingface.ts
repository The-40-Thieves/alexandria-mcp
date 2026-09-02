// Hugging Face Hub paper search, via the Hub's MCP server and its single
// filesystem-shaped tool, hf_fs: an `hf://papers` search (see hf_fs's own
// tool description, fetched live from tools/list, for the exact command
// grammar). No API key required. read() delegates straight to the
// existing arxiv source rather than calling back out to hf_fs, since
// every hit's `path` is a bare arXiv id.
import type { LibraryResult } from '../../types.js';
import type { RemoteServerConfig } from '../../utils/mcpClientPool.js';
import { defineMcpSourceWithDelegatedRead } from '../kinds/mcp.js';
import { getAdapter } from '../registry.js';

const SERVER: RemoteServerConfig = {
  name: 'huggingface',
  url: 'https://huggingface.co/mcp',
  timeoutMs: 25000,
};

interface HfFsPaperEntry {
  type?: string;
  path?: string;
  title?: string;
  description?: string;
  upvotes?: number;
  published_at?: string;
  url?: string;
  arxiv_url?: string;
}

interface HfFsOperationResult {
  index: number;
  status: 'success' | 'error';
  result?: { entries?: HfFsPaperEntry[] };
}

interface HfFsToolResult {
  results?: HfFsOperationResult[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

// hf_fs's structuredContent for a `search` operation: results[0].result
// .entries[], each a { type: 'paper', path: <arxiv id>, title,
// description, upvotes, published_at, url, arxiv_url } (confirmed via a
// live call against hf://papers on 2026-09-02; see the task-5 report).
export function normalizeHuggingFace(_text: string, structured: unknown): LibraryResult[] {
  const data = structured as HfFsToolResult | undefined;
  const entries = data?.results?.[0]?.result?.entries ?? [];
  return entries
    .filter((e): e is HfFsPaperEntry & { path: string } => e.type === 'paper' && Boolean(e.path))
    .map((e) => ({
      id: e.path,
      source: 'huggingface',
      title: e.title || e.path,
      authors: [],
      year: yearOf(e.published_at),
      hasFullText: true,
      description: e.description,
      published: e.published_at,
      url: e.url ?? e.arxiv_url,
    }));
}

defineMcpSourceWithDelegatedRead(
  {
    name: 'huggingface',
    description:
      'Hugging Face Hub paper search via its MCP hf_fs tool (an hf://papers search). Full text is read via the arxiv source (every result id is a bare arXiv id). No API key required.',
    cluster: 'ai_research',
    freshness: 'daily',
    homepage: 'https://huggingface.co/papers',
    supportsIngest: true,
    server: SERVER,
    search: {
      tool: 'hf_fs',
      args: (q, limit) => ({
        operations: [
          {
            cmd: 'search',
            args: ['hf://papers', q, '--limit', String(Math.min(Math.max(limit, 1), 30))],
          },
        ],
      }),
      normalize: normalizeHuggingFace,
    },
    expectTools: ['hf_fs'],
    verifiedAt: '2026-09-02',
  },
  (id) => getAdapter('arxiv').read(id),
);
