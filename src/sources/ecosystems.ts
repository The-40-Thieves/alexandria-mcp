// Ecosyste.ms Packages: cross-registry package metadata. Requires
// CONTACT_EMAIL so requests carry a courteous User-Agent
// (alexandria-mcp/10 (mailto:<email>)); defineRest()'s raw auth injection
// sets the header value to the bare env value, not that wrapped format, so
// this is a custom register() rather than defineRest(), per the plan.
//
// The plan's documented endpoint (GET /api/v1/packages/search?q=...) 404s
// as of 2026-09-01; ecosyste.ms's actual openapi.yaml
// (packages.ecosyste.ms/docs/api/v1/openapi.yaml) has no /packages/search
// path at all, only /packages/lookup?name=..., an exact (not full-text)
// name match across every registry. Use that instead.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const BASE = 'https://packages.ecosyste.ms/api/v1';

interface EcosystemsPackage {
  name: string;
  ecosystem: string;
  description?: string | null;
  homepage?: string | null;
  registry_url?: string | null;
  latest_release_published_at?: string;
}

function requireContactEmail(): string {
  const email = process.env.CONTACT_EMAIL;
  if (!email) throw new Error('ecosystems requires CONTACT_EMAIL');
  return email;
}

function headers(): Record<string, string> {
  return { 'User-Agent': `alexandria-mcp/10 (mailto:${requireContactEmail()})` };
}

export function normalizeEcosystems(pkg: EcosystemsPackage): LibraryResult {
  const year = pkg.latest_release_published_at
    ? new Date(pkg.latest_release_published_at).getFullYear()
    : undefined;
  return {
    id: `${pkg.name}@${pkg.ecosystem}`,
    source: 'ecosystems',
    title: `${pkg.name} (${pkg.ecosystem})`,
    authors: [],
    year: Number.isFinite(year) ? year : undefined,
    hasFullText: Boolean(pkg.description),
    description: pkg.description ?? undefined,
    previewUrl: pkg.homepage || pkg.registry_url || undefined,
  };
}

function parseId(id: string): { name: string; ecosystem: string } {
  const at = id.lastIndexOf('@');
  if (at < 0) return { name: id, ecosystem: '' };
  return { name: id.slice(0, at), ecosystem: id.slice(at + 1) };
}

export async function ecosystemsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<EcosystemsPackage[]>(
    `${BASE}/packages/lookup?name=${encodeURIComponent(query)}`,
    { headers: headers() },
  );
  return data.slice(0, limit).map(normalizeEcosystems);
}

export async function ecosystemsRead(id: string): Promise<ReadResult> {
  const { name, ecosystem } = parseId(id);
  const data = await fetchJSON<EcosystemsPackage[]>(
    `${BASE}/packages/lookup?name=${encodeURIComponent(name)}`,
    { headers: headers() },
  );
  const pkg = data.find((p) => p.ecosystem === ecosystem) ?? data[0];
  if (!pkg) throw new Error(`ecosystems: ${id} not found`);
  return {
    title: `${pkg.name} (${pkg.ecosystem})`,
    authors: [],
    text: pkg.description || `No description available for ${id}.`,
  };
}

register('ecosystems', {
  description:
    'Ecosyste.ms Packages: exact package name lookup across every open source package registry it indexes (npm, PyPI, crates.io, RubyGems, and more). Requires CONTACT_EMAIL (sent as a courteous User-Agent mailto).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://packages.ecosyste.ms',
  auth: { type: 'header', env: 'CONTACT_EMAIL', header: 'User-Agent' },
  search: ecosystemsSearch,
  read: ecosystemsRead,
});
