import fs from 'node:fs';
import path from 'node:path';
// Stage 1 (Task 1.1) creates src/sources/all.ts as a barrel; until then this
// duplicates the import list from src/index.ts. Replace with a single
// `import '../src/sources/all.js';` once that barrel exists.
import '../src/sources/gutenberg.js';
import '../src/sources/openlibrary.js';
import '../src/sources/archive.js';
import '../src/sources/sacredtexts.js';
import '../src/sources/wikisource.js';
import '../src/sources/standardebooks.js';
import '../src/sources/perseus.js';
import '../src/sources/ctext.js';
import '../src/sources/gallica.js';
import '../src/sources/loc.js';
import '../src/sources/hathitrust.js';
import '../src/sources/dpla.js';
import '../src/sources/ndl.js';
import '../src/sources/europeana.js';
import '../src/sources/trove.js';
import '../src/sources/bhl.js';
import '../src/sources/digitalnz.js';
import '../src/sources/internetclassics.js';
import '../src/sources/marxists.js';
import '../src/sources/projectruneberg.js';
import '../src/sources/cervantes.js';
import '../src/sources/doab.js';
import '../src/sources/googlebooks.js';
import '../src/sources/chroniclingamerica.js';
import '../src/sources/ccel.js';
import '../src/sources/feedbooks.js';
import '../src/sources/wdl.js';
import '../src/sources/datagov.js';
import '../src/sources/arxiv.js';
import '../src/sources/core.js';
import '../src/sources/europmc.js';
import '../src/sources/nasa.js';
import '../src/sources/osti.js';
import '../src/sources/eric.js';
import '../src/sources/nsf.js';
import '../src/sources/courtlistener.js';
import '../src/sources/biorxiv.js';
import '../src/sources/zenodo.js';
import '../src/sources/semanticscholar.js';
import '../src/sources/govinfo.js';
import '../src/sources/nih.js';
import '../src/sources/nbnorway.js';
import '../src/sources/legislation.js';
import '../src/sources/osf.js';
import '../src/sources/earlyprint.js';
import '../src/sources/openiti.js';
import '../src/sources/legislationscot.js';
import '../src/sources/openalex.js';
import '../src/sources/plos.js';
import '../src/sources/nasaads.js';
import '../src/sources/smithsonian.js';
import '../src/sources/doaj.js';
import '../src/sources/nara.js';
import '../src/sources/springer.js';
import '../src/sources/harvardlib.js';
import '../src/sources/apollo.js';
import '../src/sources/ora.js';
import '../src/sources/base.js';
import '../src/sources/codewiki.js';
import '../src/sources/youtube.js';
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
    JSON.stringify(out, null, 2),
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
