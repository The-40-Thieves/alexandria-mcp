import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { blsRead, normalizeBlsSeries, searchBundledSeries } from '../bls.ts';
import { getAdapter, listSources } from '../registry.ts';

const timeseriesFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/bls-timeseries.json'), 'utf8'),
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('bls adapter declares a conservative keyless daily cap', () => {
  const meta = listSources().find((s) => s.name === 'bls');
  assert.ok(meta);
  assert.equal(meta?.pacing?.dailyCap, 25);
  assert.deepEqual(meta?.optionalEnv, ['BLS_API_KEY']);
});

test('searchBundledSeries', () => {
  const out = searchBundledSeries('unemployment rate', 10);
  assert.ok(out.length > 0);
  assert.ok(out.every((s) => s.name.toLowerCase().includes('unemployment rate')));
});

test('searchBundledSeries applies limit', () => {
  const out = searchBundledSeries('rate', 1);
  assert.equal(out.length, 1);
});

test('normalizeBlsSeries', () => {
  const out = normalizeBlsSeries({ id: 'LNS14000000', name: 'Unemployment rate' });
  assert.equal(out.id, 'LNS14000000');
  assert.equal(out.source, 'bls');
  assert.equal(out.title, 'Unemployment rate');
  assert.equal(out.previewUrl, 'https://data.bls.gov/timeseries/LNS14000000');
});

test('blsSearch via the registered adapter matches the bundled catalog with no network call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('blsSearch must not hit the network');
  }) as typeof fetch;
  try {
    const out = await getAdapter('bls').search('consumer price index', 5);
    assert.ok(out.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blsRead', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.BLS_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.BLS_API_KEY;
    else process.env.BLS_API_KEY = originalEnv;
  });

  await t.test('POSTs the series id and folds in a registrationkey when set', async () => {
    process.env.BLS_API_KEY = 'test-key';
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.equal(String(url), 'https://api.bls.gov/publicAPI/v2/timeseries/data/');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.seriesid, ['LNS14000000']);
      assert.equal(body.registrationkey, 'test-key');
      return jsonResponse(timeseriesFixture);
    }) as typeof fetch;
    const result = await blsRead('LNS14000000');
    assert.equal(result.title, 'Unemployment rate, seasonally adjusted');
    assert.match(result.text ?? '', /December 2025: 4\.4/);
  });

  await t.test('omits registrationkey when BLS_API_KEY is unset', async () => {
    delete process.env.BLS_API_KEY;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.equal('registrationkey' in body, false);
      return jsonResponse(timeseriesFixture);
    }) as typeof fetch;
    await blsRead('LNS14000000');
  });

  await t.test('throws for a series with no data', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ status: 'REQUEST_SUCCEEDED', Results: { series: [] } })) as typeof fetch;
    await assert.rejects(() => blsRead('XXNONEXISTENT'), /BLS series not found/);
  });
});

test('bls adapter is registered', () => {
  assert.ok(getAdapter('bls'));
});

// Final wave (F2): the description promises "set BLS_API_KEY for the
// registered 500/day tier" while pacing.dailyCap was a flat 25, so an
// operator who set the key got a twentieth of the throughput they were
// told they had, throttled silently by the cap.
//
// The registry reads `pacing` once, at registration (module load), so this
// re-imports bls.ts in a child process with and without the key rather
// than trying to mutate env after the fact - which would prove nothing.
test('bls: the daily cap is key-aware', async (t) => {
  const script = `
    const { listSources } = await import('${path.resolve(process.cwd(), 'src/sources/registry.ts')}');
    await import('${path.resolve(process.cwd(), 'src/sources/bls.ts')}');
    const bls = listSources().find((s) => s.name === 'bls');
    console.log(JSON.stringify({ dailyCap: bls?.pacing?.dailyCap }));
  `;
  const run = (key: string | undefined): { dailyCap?: number } => {
    const env: NodeJS.ProcessEnv = { ...process.env, ALEXANDRIA_STATE_DB: ':memory:' };
    if (key === undefined) delete env.BLS_API_KEY;
    else env.BLS_API_KEY = key;
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env,
    });
    return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
  };

  await t.test('keyless stays at the conservative 25/day', () => {
    assert.equal(run(undefined).dailyCap, 25);
  });

  await t.test('with BLS_API_KEY set it is the registered 500/day tier', () => {
    assert.equal(run('test-bls-key').dailyCap, 500);
  });
});
