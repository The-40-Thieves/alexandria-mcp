// Google Code Wiki — batchexecute protocol client + Alexandria adapter
// Reverse-engineered from https://github.com/izzzzzi/codewiki-mcp

import type { LibraryResult } from '../types.js';
import { register, truncateText } from './registry.js';

const BATCH_URL = 'https://codewiki.google/_/BoqAngularSdlcAgentsUi/data/batchexecute';

// RPC IDs (stable as of May 2026)
const RPC_SEARCH = 'vyWDAf';
const RPC_FETCH = 'VSX6ub';

// --- batchexecute protocol ---

function stripXssi(text: string): string {
  const t = text.trimStart();
  // Google prefixes all batchexecute responses with )]}' to prevent JSON hijacking
  return t.startsWith(")]}'\n") ? t.slice(5) : t.startsWith(")]}'") ? t.slice(4) : t;
}

function safeJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function collectFrames(node: unknown, out: Array<{ rpcId: string; payload: unknown }>): void {
  if (!Array.isArray(node)) return;
  if (node.length >= 3 && node[0] === 'wrb.fr' && typeof node[1] === 'string') {
    const raw = node[2];
    const payload = typeof raw === 'string' ? (safeJson(raw) ?? raw) : raw;
    out.push({ rpcId: node[1] as string, payload });
    return;
  }
  for (const child of node) collectFrames(child, out);
}

function extractPayload(responseText: string, rpcId: string): unknown {
  const body = stripXssi(responseText);
  const frames: Array<{ rpcId: string; payload: unknown }> = [];
  for (const line of body.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith('[') && l.endsWith(']')) {
      const parsed = safeJson(l);
      if (parsed !== undefined) collectFrames(parsed, frames);
    }
  }
  const match = frames.find((f) => f.rpcId === rpcId);
  if (!match) {
    const available = frames.map((f) => f.rpcId).join(', ');
    throw new Error(
      `CodeWiki RPC ${rpcId} not found in response (available: ${available || 'none'})`,
    );
  }
  return match.payload;
}

async function callRpc(rpcId: string, rpcPayload: unknown, sourcePath = '/'): Promise<unknown> {
  const url = new URL(BATCH_URL);
  url.searchParams.set('rpcids', rpcId);
  url.searchParams.set('rt', 'c');
  url.searchParams.set('source-path', sourcePath);

  const bodyObj = [[[rpcId, JSON.stringify(rpcPayload), null, 'generic']]];
  const body = `f.req=${encodeURIComponent(JSON.stringify(bodyObj))}&`;

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  if (!res.ok) throw new Error(`CodeWiki RPC ${rpcId} failed: HTTP ${res.status}`);
  return extractPayload(await res.text(), rpcId);
}

// --- repo normalization ---

function normalizeRepo(input: string): {
  repoPath: string;
  repoUrl: string;
  sourcePath: string;
} {
  // Accept: "owner/repo", "github.com/owner/repo", "https://github.com/owner/repo"
  const s = input
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\/$/, '');
  return {
    repoPath: s,
    repoUrl: `https://github.com/${s}`,
    sourcePath: `/github.com/${s}`,
  };
}

// --- search ---

export async function codewikiSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const payload = (await callRpc(RPC_SEARCH, [query, limit, query, 0], '/')) as unknown[];
  const rows = Array.isArray(payload[0]) ? (payload[0] as unknown[]) : [];

  return rows
    .filter((item): item is unknown[] => Array.isArray(item))
    .map((item) => {
      const fullName = typeof item[0] === 'string' ? item[0] : 'unknown/unknown';
      const url =
        Array.isArray(item[3]) && typeof (item[3] as unknown[])[1] === 'string'
          ? (item[3] as string[])[1]
          : null;
      const meta = Array.isArray(item[5]) ? (item[5] as unknown[]) : [];
      const description = typeof meta[0] === 'string' ? (meta[0] as string) : undefined;
      return {
        id: fullName,
        source: 'codewiki' as const,
        title: fullName,
        authors: [],
        subjects: [],
        hasFullText: true,
        previewUrl: url ?? `https://codewiki.google/github.com/${fullName}`,
        description: description?.substring(0, 300),
      };
    });
}

// --- read/fetch ---

export async function codewikiRead(repoInput: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const repo = normalizeRepo(repoInput);
  const payload = (await callRpc(RPC_FETCH, [repo.repoUrl], repo.sourcePath)) as unknown[];

  const primary = Array.isArray(payload[0]) ? (payload[0] as unknown[]) : [];
  const sectionsRaw = Array.isArray(primary[1]) ? (primary[1] as unknown[]) : [];

  const sections = sectionsRaw
    .filter((item): item is unknown[] => Array.isArray(item))
    .map((item) => {
      const title = typeof item[0] === 'string' ? item[0] : 'Untitled';
      // markdown is at index 5, fallback to 4, then summary at 2
      const markdown =
        typeof item[5] === 'string'
          ? item[5]
          : typeof item[4] === 'string'
            ? item[4]
            : typeof item[2] === 'string'
              ? item[2]
              : '';
      return `## ${title}\n\n${markdown}`.trim();
    })
    .filter(Boolean);

  const text = sections.join('\n\n---\n\n') || `No wiki content available for ${repo.repoPath}`;

  return { text, title: repo.repoPath, authors: [], language: 'en' };
}

register('codewiki', {
  description:
    'Google Code Wiki — AI-generated continuously updated docs for any GitHub repo. Search indexed repos or fetch architecture overviews, API references, and class diagrams by passing "{owner}/{repo}". No auth required.',
  supportsIngest: true,
  search: codewikiSearch,
  async read(id) {
    const raw = await codewikiRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
