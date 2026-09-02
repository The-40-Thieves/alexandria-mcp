// GitHub code search. Requires GITHUB_TOKEN: GitHub's /search/code endpoint
// returns 401 for unauthenticated requests, unlike /search/repositories.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.github.com';

interface GithubCodeItem {
  name: string;
  path: string;
  html_url: string;
  repository: { full_name: string };
}

interface GithubCodeSearchResponse {
  items: GithubCodeItem[];
}

interface GithubContentResponse {
  content?: string;
  encoding?: string;
}

export function normalizeGithubSearch(item: GithubCodeItem): LibraryResult {
  return {
    id: `${item.repository.full_name}#${item.path}`,
    source: 'githubsearch',
    title: `${item.repository.full_name}: ${item.path}`,
    authors: [],
    hasFullText: false,
    url: item.html_url,
  };
}

defineRest<GithubCodeSearchResponse>({
  name: 'githubsearch',
  description:
    'GitHub code search: full-text search across public repository contents. Requires GITHUB_TOKEN (the /search/code endpoint rejects unauthenticated requests).',
  cluster: 'developer',
  freshness: 'realtime',
  homepage: 'https://github.com/search',
  supportsIngest: true,
  auth: { type: 'bearer', env: 'GITHUB_TOKEN' },
  pacing: { minIntervalMs: 2100 },
  search: {
    url: (q, limit) => `${BASE}/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`,
    pick: (raw) => raw.items ?? [],
    normalize: normalizeGithubSearch,
  },
  read: {
    url: (id) => {
      const hashIndex = id.indexOf('#');
      const repo = id.slice(0, hashIndex);
      const filePath = id.slice(hashIndex + 1);
      return `${BASE}/repos/${repo}/contents/${filePath}`;
    },
    normalize: (raw: GithubContentResponse, id: string) => {
      const decoded =
        raw.content && raw.encoding === 'base64'
          ? Buffer.from(raw.content, 'base64').toString('utf8')
          : (raw.content ?? '');
      return {
        title: id,
        authors: [],
        ...truncateText(decoded || `No content found for ${id}.`),
      };
    },
  },
});
