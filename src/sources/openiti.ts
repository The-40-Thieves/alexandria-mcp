import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

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
    .replace(/PageV\d+P\d+/g, '')                      // strip page markers
    .replace(/^### \|/gm, '')                           // strip section markers
    .replace(/^# /gm, '')                               // strip paragraph markers
    .replace(/\.Milestone\d+/g, '')                    // strip milestones
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

export async function openitiSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  // Search for files in OpenITI org by filename/path (author+work in filename)
  const data = await fetchJSON<GHCodeResponse>(
    `${GH_API}/search/code?q=${encodeURIComponent(query)}+org:${ORG}+in:path&per_page=${limit}`,
    { headers: { ...ghHeaders(), Accept: 'application/vnd.github+json' } }
  );

  return (data.items || []).map(item => {
    // Path like: data/0505Ghazali/0505Ghazali.IhyaCulumDin/0505Ghazali.IhyaCulumDin.Shamela0011606-ara1
    const parts = item.name.split('.');
    const authorWork = parts.slice(0, 2).join(' — ') || item.name;
    const id = `${item.repository.name}||${item.path}`;
    return {
      id,
      source: 'openiti' as const,
      title: authorWork,
      authors: parts[0] ? [parts[0]] : [],
      subjects: ['Islamic', 'Islamicate'],
      hasFullText: true,
      previewUrl: item.html_url,
    };
  });
}

export async function openitiRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
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
  description: 'OpenITI — 10,000+ Islamicate texts in Arabic and Persian (OpenITI mARkdown). Set GITHUB_TOKEN for higher rate limits.',
  supportsIngest: true,
  search: openitiSearch,
  async read(id) {
    const raw = await openitiRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
