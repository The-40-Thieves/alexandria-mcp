import fs from 'node:fs';
import path from 'node:path';
import '../src/sources/all.js';
import { getAdapter, listSources } from '../src/sources/registry.js';

export type ProbeStatus = 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT' | 'KEY_MISSING';
export interface ProbeResult {
  status: ProbeStatus;
  ms: number;
  count: number;
  message?: string;
}

// Sources whose search() is expected to return [] by design (not a live
// failure), e.g. hathitrust, whose only remaining public endpoint is a
// lookup-by-identifier, not a keyword search. An OK -> EMPTY transition for
// one of these is not a regression.
export const EXPECTED_EMPTY = new Set<string>(['hathitrust']);

export const PROBE_QUERIES: Record<string, string> = {
  gallica: 'histoire des sciences',
  projectruneberg: 'Ibsen',
  cervantes: 'Quijote',
  legislationscot: 'education',
  legislation: 'data protection',
  codewiki: 'react hooks',
  youtube: 'lecture',
  // api.ctext.org's searchtexts does a case-sensitive prefix match against
  // its English title index: "analects" returns zero books, "Analects" does.
  ctext: 'Analects',
  openiti: 'hadith',
  nasa: 'mars rover',
  // biorxiv has no free-text search API; search() scans the last 7 days of
  // postings client-side, so the probe query needs to be common enough to
  // hit within the first page or two rather than exhausting MAX_PAGES.
  biorxiv: 'cell',
  // The RSS-kind sources and nhk filter client-side by exact token match
  // against whatever happens to be in the feed right now; an empty query
  // skips that filter and returns the newest items, which is a reliable
  // live probe. googlenews is a real per-query search API, so it gets an
  // ordinary query instead.
  exploitdb: '',
  msrc: '',
  projectzero: '',
  'cisco-psirt': '',
  bleepingcomputer: '',
  allafrica: '',
  arabnews: '',
  'thehindu-intl': '',
  'abc-world': '',
  'folha-en': '',
  dw: '',
  france24: '',
  aljazeera: '',
  almonitor: '',
  thediplomat: '',
  nikkeiasia: '',
  dailymaverick: '',
  restofworld: '',
  scmp: '',
  'nist-csrc': '',
  lobsters: '',
  nhk: '',
  googlenews: 'technology',
  // osv.dev's package query needs an ecosystem:name pair and rejects a bare
  // keyword; a direct advisory id exercises the GET lookup branch instead.
  osv: 'CVE-2021-44228',
  // kev filters its whole-catalog download client-side by exact token
  // match; an empty query skips the filter and returns the first entries,
  // a reliable live probe (like the RSS-kind sources above).
  kev: '',
  euvd: 'openssl',
  // epss only accepts a single CVE id; the default query isn't one.
  epss: 'CVE-2021-44228',
  nvd: 'openssl',
  // cwe is a single-id lookup with no keyword search; the default query
  // isn't a CWE number.
  cwe: 'CWE-79',
  attack: 'injection',
  depsdev: 'npm:lodash',
  // devto's multi-token search feed returns [] for every query as of
  // 2026-09-01 (see the task report); a single token exercises the
  // working tag-filtered branch instead.
  devto: 'rust',
  peps: 'style guide',
};
const DEFAULT_QUERY = 'history of science';

export function classify(x: { results: unknown[] | null; error: Error | null }): ProbeStatus {
  if (x.error) {
    if (/requires .*(key|token|env)/i.test(x.error.message)) return 'KEY_MISSING';
    return /abort/i.test(x.error.message) ? 'TIMEOUT' : 'ERROR';
  }
  return (x.results?.length ?? 0) > 0 ? 'OK' : 'EMPTY';
}

export function regressions(
  base: Record<string, { status: string }>,
  now: Record<string, { status: string }>,
  hasAuth: (source: string) => boolean = () => false,
): string[] {
  // A source absent from `now` (e.g. deleted from the registry) is a
  // deliberate removal, not a regression, only a source still present but
  // no longer OK counts.
  return Object.keys(base)
    .filter((s) => {
      if (base[s].status !== 'OK') return false;
      const now_ = now[s];
      if (now_ === undefined || now_.status === 'OK') return false;
      // An unconfigured key (no env var set in this environment) is expected
      // for a source that declares auth; only a source with no auth
      // declared going from OK to KEY_MISSING is a real regression.
      if (now_.status === 'KEY_MISSING' && hasAuth(s)) return false;
      if (now_.status === 'EMPTY' && EXPECTED_EMPTY.has(s)) return false;
      return true;
    })
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
    const authBySource = new Map(listSources().map((s) => [s.name, Boolean(s.auth)]));
    const bad = regressions(base, results, (s) => authBySource.get(s) ?? false);
    if (bad.length) {
      console.error(`REGRESSION: ${bad.join(', ')}`);
      process.exit(1);
    }
  }
}
if (process.argv[1]?.endsWith('probe.ts') || process.argv[1]?.endsWith('probe.js')) main();
