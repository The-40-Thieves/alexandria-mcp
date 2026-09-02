// The generic REST/JSON adapter kind. defineRest() builds search() (and,
// when declared, read()) from a small declarative spec: a URL builder, how
// to pick the item array out of the raw JSON response, and how to normalize
// one raw item into a LibraryResult (or null to drop it). Auth is injected
// generically from AuthSpec so individual adapters don't hand-roll it.
import type { LibraryResult, ReadResult } from '../../types.js';
import { DEFAULT_TIMEOUT_MS, fetchJSON } from '../../utils/http.js';
import type { AuthSpec, Cluster, Freshness, SourceMeta } from '../registry.js';
import { register } from '../registry.js';

export interface RestSpec<TRaw> {
  name: string;
  description: string;
  cluster: Cluster;
  freshness: Freshness;
  homepage: string;
  supportsIngest: boolean;
  auth?: AuthSpec;
  pacing?: SourceMeta['pacing'];
  timeoutMs?: number;
  headers?: Record<string, string>;
  verifiedAt?: string;
  search: {
    url: (q: string, limit: number) => string;
    method?: 'GET' | 'POST';
    body?: (q: string, limit: number) => unknown;
    pick: (raw: TRaw) => unknown[];
    // biome-ignore lint/suspicious/noExplicitAny: RestSpec's normalize() takes `any` per the task-4.0 brief; each caller narrows its own item shape.
    normalize: (item: any, q: string) => LibraryResult | null;
  };
  read?: {
    url: (id: string) => string;
    // biome-ignore lint/suspicious/noExplicitAny: RestSpec's normalize() takes `any` per the task-4.0 brief; each caller narrows its own raw shape.
    normalize: (raw: any, id: string) => ReadResult;
  };
}

// Throws "<name> requires <ENV>" when auth is declared and its env var is
// absent; scripts/probe.ts's classify() matches that exact wording to
// report KEY_MISSING instead of ERROR.
function requireAuthValue(name: string, auth?: AuthSpec): string | undefined {
  if (!auth || auth.type === 'none') return undefined;
  const value = auth.env ? process.env[auth.env] : undefined;
  if (!value) throw new Error(`${name} requires ${auth.env}`);
  return value;
}

function applyAuth(
  url: string,
  headers: Record<string, string>,
  auth: AuthSpec | undefined,
  value: string | undefined,
): { url: string; headers: Record<string, string> } {
  if (!auth || auth.type === 'none' || !value) return { url, headers };
  if (auth.type === 'query') {
    const u = new URL(url);
    u.searchParams.set(auth.param ?? 'key', value);
    return { url: u.toString(), headers };
  }
  if (auth.type === 'header') {
    return { url, headers: { ...headers, [auth.header ?? 'Authorization']: value } };
  }
  // 'bearer'
  return { url, headers: { ...headers, Authorization: `Bearer ${value}` } };
}

export function defineRest<TRaw>(spec: RestSpec<TRaw>): void {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function search(query: string, limit: number): Promise<LibraryResult[]> {
    const authValue = requireAuthValue(spec.name, spec.auth);
    const { url, headers } = applyAuth(
      spec.search.url(query, limit),
      { ...spec.headers },
      spec.auth,
      authValue,
    );
    const method = spec.search.method ?? 'GET';
    const init: RequestInit = { method, headers };
    if (method === 'POST') {
      init.headers = { 'Content-Type': 'application/json', ...headers };
      if (spec.search.body) init.body = JSON.stringify(spec.search.body(query, limit));
    }
    const raw = await fetchJSON<TRaw>(url, init, timeoutMs);
    const picked = spec.search.pick(raw);
    const results: LibraryResult[] = [];
    for (const item of picked) {
      const normalized = spec.search.normalize(item, query);
      if (normalized) results.push(normalized);
    }
    return results;
  }

  async function read(id: string): Promise<ReadResult> {
    if (!spec.read) throw new Error(`${spec.name} does not support read()`);
    const authValue = requireAuthValue(spec.name, spec.auth);
    const { url, headers } = applyAuth(
      spec.read.url(id),
      { ...spec.headers },
      spec.auth,
      authValue,
    );
    const raw = await fetchJSON<unknown>(url, { headers }, timeoutMs);
    return spec.read.normalize(raw, id);
  }

  register(spec.name, {
    description: spec.description,
    supportsIngest: spec.supportsIngest,
    kind: 'rest',
    cluster: spec.cluster,
    freshness: spec.freshness,
    homepage: spec.homepage,
    timeoutMs,
    headers: spec.headers,
    auth: spec.auth,
    pacing: spec.pacing,
    verifiedAt: spec.verifiedAt,
    search,
    read,
  });
}
