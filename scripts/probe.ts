import fs from 'node:fs';
import path from 'node:path';
import '../src/sources/all.js';
import { getAdapter, listSources } from '../src/sources/registry.js';

export type ProbeStatus = 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT';
export interface ProbeResult {
  status: ProbeStatus;
  ms: number;
  count: number;
  message?: string;
}

export const PROBE_QUERIES: Record<string, string> = {
  gallica: 'histoire des sciences',
  projectruneberg: 'Ibsen',
  cervantes: 'Quijote',
  legislationscot: 'education',
  legislation: 'data protection',
  codewiki: 'react hooks',
  youtube: 'lecture',
  ctext: 'analects',
  openiti: 'hadith',
  nasa: 'mars rover',
  base: 'machine learning',
};
const DEFAULT_QUERY = 'history of science';

export function classify(x: { results: unknown[] | null; error: Error | null }): ProbeStatus {
  if (x.error) return /abort/i.test(x.error.message) ? 'TIMEOUT' : 'ERROR';
  return (x.results?.length ?? 0) > 0 ? 'OK' : 'EMPTY';
}

export function regressions(
  base: Record<string, { status: string }>,
  now: Record<string, { status: string }>,
): string[] {
  return Object.keys(base)
    .filter((s) => base[s].status === 'OK' && now[s]?.status !== 'OK')
    .sort();
}

async function probeOne(name: string): Promise<ProbeResult> {
  const q = PROBE_QUERIES[name] ?? DEFAULT_QUERY;
  const t0 = Date.now();
  try {
    const results = await getAdapter(name).search(q, 2);
    return {
      status: classify({ results, error: null }),
      ms: Date.now() - t0,
      count: results.length,
    };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return {
      status: classify({ results: null, error: e }),
      ms: Date.now() - t0,
      count: 0,
      message: e.message.slice(0, 160),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--source='))?.slice(9);
  const writeBaseline = args.includes('--baseline');
  const names = listSources()
    .map((s) => s.name)
    .filter((n) => !only || n === only);
  const results: Record<string, ProbeResult> = {};
  for (const n of names) {
    results[n] = await probeOne(n);
    console.error(
      `${n.padEnd(20)} ${results[n].status.padEnd(8)} ${String(results[n].ms).padStart(6)}ms ${results[n].message ?? ''}`,
    );
  }
  const out = { generatedAt: new Date().toISOString(), results };
  fs.mkdirSync('eval', { recursive: true });
  fs.writeFileSync(
    path.join('eval', writeBaseline ? 'probe-baseline.json' : 'probe-latest.json'),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  const counts = Object.values(results).reduce(
    (m, r) => {
      m[r.status] = (m[r.status] ?? 0) + 1;
      return m;
    },
    {} as Record<string, number>,
  );
  console.error(JSON.stringify(counts));
  if (!writeBaseline && fs.existsSync('eval/probe-baseline.json') && !only) {
    const base = JSON.parse(fs.readFileSync('eval/probe-baseline.json', 'utf8')).results;
    const bad = regressions(base, results);
    if (bad.length) {
      console.error(`REGRESSION: ${bad.join(', ')}`);
      process.exit(1);
    }
  }
}
if (process.argv[1]?.endsWith('probe.ts') || process.argv[1]?.endsWith('probe.js')) main();
