// MITRE ATT&CK Enterprise: a single ~50MB STIX bundle, downloaded once per
// process (lazy, module-scope cache) and filtered client-side by token
// match against attack-pattern name+description, the same static-download
// convention as kev.ts, peps.ts, tc39.ts and swiftevolution.ts.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const URL =
  'https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json';
const TIMEOUT_MS = 60000;

interface StixExternalReference {
  source_name: string;
  external_id?: string;
  url?: string;
}

interface StixAttackPattern {
  type: string;
  name: string;
  description?: string;
  external_references?: StixExternalReference[];
}

interface StixBundle {
  objects: StixAttackPattern[];
}

let cached: Promise<StixAttackPattern[]> | undefined;

function techniqueId(obj: StixAttackPattern): string | undefined {
  return obj.external_references?.find((r) => r.source_name === 'mitre-attack')?.external_id;
}

function loadTechniques(): Promise<StixAttackPattern[]> {
  if (!cached) {
    cached = fetchJSON<StixBundle>(URL, {}, TIMEOUT_MS)
      .then((bundle) => bundle.objects.filter((o) => o.type === 'attack-pattern' && techniqueId(o)))
      .catch((err) => {
        cached = undefined; // let a later call retry after a failed download
        throw err;
      });
  }
  return cached;
}

function matches(t: StixAttackPattern, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${t.name} ${t.description ?? ''}`.toLowerCase();
  return tokens.every((tok) => haystack.includes(tok));
}

export function normalizeAttack(t: StixAttackPattern): LibraryResult {
  const id = techniqueId(t) ?? t.name;
  return {
    id,
    source: 'attack',
    title: `${id}: ${t.name}`,
    authors: [],
    hasFullText: Boolean(t.description),
    description: t.description?.slice(0, 300),
    previewUrl: `https://attack.mitre.org/techniques/${id.replace('.', '/')}`,
  };
}

export async function attackSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const techniques = await loadTechniques();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return techniques
    .filter((t) => matches(t, tokens))
    .slice(0, limit)
    .map(normalizeAttack);
}

export async function attackRead(id: string): Promise<ReadResult> {
  const techniques = await loadTechniques();
  const t = techniques.find((tech) => techniqueId(tech) === id);
  if (!t) throw new Error(`attack: technique ${id} not found`);
  return {
    title: `${id}: ${t.name}`,
    authors: [],
    text: t.description || `No description available for ${id}.`,
  };
}

register('attack', {
  description:
    'MITRE ATT&CK Enterprise: adversary tactics and techniques, downloaded once per process as a single STIX bundle and filtered client-side; there is no per-query search API. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'security',
  freshness: 'static',
  homepage: 'https://attack.mitre.org',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: attackSearch,
  read: attackRead,
});
