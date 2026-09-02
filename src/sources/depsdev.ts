// deps.dev v3: package version metadata across npm, PyPI, cargo, Go,
// Maven and more. Query as "system:name" (e.g. "npm:lodash"), or a bare
// name (defaults to npm). deps.dev's own /v3/query endpoint 404s
// ("no results match query") unless a specific version is also given, so
// both branches use /v3/systems/{system}/packages/{name} directly, which
// returns a package's full version list either way.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const BASE = 'https://api.deps.dev/v3';
const DEFAULT_SYSTEM = 'npm';

interface DepsDevVersion {
  versionKey: { system: string; name: string; version: string };
  publishedAt?: string;
}

interface DepsDevPackageResponse {
  versions?: DepsDevVersion[];
}

function parseQuery(query: string): { system: string; name: string } {
  const match = query.trim().match(/^([\w.-]+):(.+)$/);
  return match
    ? { system: match[1].toLowerCase(), name: match[2] }
    : { system: DEFAULT_SYSTEM, name: query.trim() };
}

function packageUrl(system: string, name: string): string {
  return `${BASE}/systems/${encodeURIComponent(system)}/packages/${encodeURIComponent(name)}`;
}

export function normalizeDepsDev(v: DepsDevVersion): LibraryResult {
  const { system, name, version } = v.versionKey;
  const year = v.publishedAt ? new Date(v.publishedAt).getFullYear() : undefined;
  return {
    id: `${system.toLowerCase()}:${name}@${version}`,
    source: 'depsdev',
    title: `${name} ${version} (${system.toLowerCase()})`,
    authors: [],
    year: Number.isFinite(year) ? year : undefined,
    hasFullText: false,
    description: v.publishedAt ? `Published ${v.publishedAt}` : undefined,
    previewUrl: `https://deps.dev/${system.toLowerCase()}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  };
}

export async function depsdevSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const { system, name } = parseQuery(query);
  const data = await fetchJSON<DepsDevPackageResponse>(packageUrl(system, name));
  return (data.versions ?? []).slice(0, limit).map(normalizeDepsDev);
}

export async function depsdevRead(id: string): Promise<ReadResult> {
  const match = id.match(/^([\w.-]+):(.+)@([^@]+)$/);
  if (!match) throw new Error(`depsdev: malformed id "${id}" (expected system:name@version)`);
  const [, system, name, version] = match;
  const raw = await fetchJSON<{
    licenses?: string[];
    links?: Array<{ label: string; url: string }>;
    publishedAt?: string;
  }>(`${packageUrl(system, name)}/versions/${encodeURIComponent(version)}`);
  const licenses = raw.licenses?.length ? `Licenses: ${raw.licenses.join(', ')}` : undefined;
  const links = raw.links?.length
    ? `Links:\n${raw.links.map((l) => `${l.label}: ${l.url}`).join('\n')}`
    : undefined;
  const text = [`${name} ${version} (${system})`, licenses, links].filter(Boolean).join('\n\n');
  return {
    title: `${name} ${version} (${system})`,
    authors: [],
    year: raw.publishedAt ? new Date(raw.publishedAt).getFullYear() : undefined,
    text,
  };
}

register('depsdev', {
  description:
    'deps.dev v3: package version metadata (licenses, dependency links, advisories) across npm, PyPI, cargo, Go, Maven and more. Query as system:name (e.g. npm:lodash); a bare name defaults to npm.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://deps.dev',
  verifiedAt: '2026-09-01',
  search: depsdevSearch,
  read: depsdevRead,
});
