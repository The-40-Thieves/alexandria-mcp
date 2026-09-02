import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const GH_API = 'https://api.github.com';
const GH_RAW = 'https://raw.githubusercontent.com';
const ORG = 'OpenITI';

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/^######OpenITI#[\s\S]*?#META#END#/m, '') // strip metadata header
    .replace(/PageV\d+P\d+/g, '') // strip page markers
    .replace(/^### \|/gm, '') // strip section markers
    .replace(/^# /gm, '') // strip paragraph markers
    .replace(/\.Milestone\d+/g, '') // strip milestones
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface GHCodeItem {
  name: string;
  path: string;
  html_url?: string;
  download_url?: string;
  repository: { name: string; full_name: string };
}

interface GHCodeResponse {
  total_count: number;
  items: GHCodeItem[];
}

// GitHub's code search API now requires authentication for every caller,
// even against public repos (confirmed live: an unauthenticated
// /search/code request returns 401 "Requires authentication"). Without
// GITHUB_TOKEN, fall back to listing a small set of OpenITI's per-century
// data repos via the unauthenticated git Trees API and filtering file
// paths client-side: a real, keyless (if narrower) search over the same
// corpus rather than failing outright.
const FALLBACK_REPOS = ['0500AH', '0600AH', '0700AH'];

function pathToResult(repo: string, path: string, previewUrl?: string): LibraryResult {
  const name = path.split('/').pop() ?? '';
  const parts = name.split('.');
  const authorWork = parts.slice(0, 2).join(', ') || name;
  return {
    id: `${repo}||${path}`,
    source: 'openiti' as const,
    title: authorWork,
    authors: parts[0] ? [parts[0]] : [],
    subjects: ['Islamic', 'Islamicate'],
    hasFullText: true,
    previewUrl: previewUrl ?? `https://github.com/${ORG}/${repo}/blob/master/${path}`,
  };
}

interface GHTreeItem {
  path: string;
  type: string;
}
interface GHTreeResponse {
  tree: GHTreeItem[];
  truncated?: boolean;
}

// A leaf text file's path looks like:
//   data/0505Ghazali/0505Ghazali.IhyaCulumDin/0505Ghazali.IhyaCulumDin.Shamela0011606-ara1
// (no extension). Skip .yml metadata, README.md, and directory entries.
function isTextFilePath(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return (
    path.startsWith('data/') &&
    !name.endsWith('.yml') &&
    !name.toLowerCase().startsWith('readme') &&
    name.split('.').length >= 2
  );
}

async function openitiUnauthedSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: LibraryResult[] = [];

  for (const repo of FALLBACK_REPOS) {
    if (results.length >= limit) break;
    try {
      const data = await fetchJSON<GHTreeResponse>(
        `${GH_API}/repos/${ORG}/${repo}/git/trees/master?recursive=1`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      for (const item of data.tree) {
        if (item.type !== 'blob' || !isTextFilePath(item.path)) continue;
        const haystack = item.path.toLowerCase();
        if (!terms.some((t) => haystack.includes(t))) continue;
        results.push(pathToResult(repo, item.path));
        if (results.length >= limit) break;
      }
    } catch {
      /* skip a repo whose tree fetch failed and try the next */
    }
  }

  return results.slice(0, limit);
}

export async function openitiSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  if (!process.env.GITHUB_TOKEN) return openitiUnauthedSearch(query, limit);

  const data = await fetchJSON<GHCodeResponse>(
    `${GH_API}/search/code?q=${encodeURIComponent(query)}+org:${ORG}+in:path&per_page=${limit}`,
    { headers: { ...ghHeaders(), Accept: 'application/vnd.github+json' } },
  );

  return (data.items || []).map((item) =>
    pathToResult(item.repository.name, item.path, item.html_url),
  );
}

export async function openitiRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const sep = id.indexOf('||');
  if (sep === -1) throw new Error(`Invalid OpenITI ID format: ${id}. Expected {repo}||{path}`);
  const repo = id.substring(0, sep);
  const path = id.substring(sep + 2);

  // Try master branch first (OpenITI repos use master), then main
  let raw = '';
  try {
    raw = await fetchText(`${GH_RAW}/${ORG}/${repo}/master/${path}`);
  } catch {
    raw = await fetchText(`${GH_RAW}/${ORG}/${repo}/main/${path}`);
  }

  const text = cleanMarkdown(raw);
  if (text.length < 50) {
    throw new Error(`OpenITI file ${id} returned no usable text.`);
  }

  const parts = path.split('/').pop()?.split('.') || [];
  const title = parts.slice(0, 2).join(' — ') || path;
  const author = parts[0] || '';

  return {
    text,
    title,
    authors: author ? [author] : [],
    language: path.includes('-ara') ? 'ar' : path.includes('-per') ? 'fa' : undefined,
  };
}

register('openiti', {
  description:
    'OpenITI: 10,000+ Islamicate texts in Arabic and Persian (OpenITI mARkdown). Set GITHUB_TOKEN for full-corpus code search; without it, search falls back to a small set of per-century data repos (GitHub code search now requires auth even for public repos).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://openiti.org',
  verifiedAt: '2026-09-01',
  // Enables GitHub code search; without it the source falls back to an unauthenticated path.
  optionalEnv: ['GITHUB_TOKEN'],
  search: openitiSearch,
  async read(id) {
    const raw = await openitiRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
