import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter } from '../registry.ts';
import {
  matchesIndicator,
  normalizeWorldbankIndicator,
  worldbankRead,
  worldbankSearch,
} from '../worldbank.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

const indicatorsFixture = fixture('worldbank-indicators.json') as [
  unknown,
  Array<{ id: string; name: string; sourceNote?: string; topics?: Array<{ value?: string }> }>,
];
const seriesFixture = fixture('worldbank-series.json');

test('matchesIndicator', () => {
  const inflation = indicatorsFixture[1].find((i) => i.id === 'FP.CPI.TOTL.ZG');
  if (!inflation) throw new Error('fixture missing FP.CPI.TOTL.ZG');
  assert.equal(matchesIndicator(inflation, 'inflation'), true);
  assert.equal(matchesIndicator(inflation, 'inflation consumer'), true);
  assert.equal(matchesIndicator(inflation, 'nonexistentterm'), false);
});

test('normalizeWorldbankIndicator', () => {
  const gdp = indicatorsFixture[1].find((i) => i.id === '6.0.GDP_growth');
  if (!gdp) throw new Error('fixture missing 6.0.GDP_growth');
  const out = normalizeWorldbankIndicator(gdp);
  assert.equal(out.id, '6.0.GDP_growth');
  assert.equal(out.source, 'worldbank');
  assert.equal(out.hasFullText, true);
  assert.equal(out.previewUrl, 'https://data.worldbank.org/indicator/6.0.GDP_growth');
  assert.deepEqual(out.subjects, ['Economy & Growth']);
});

test('worldbankSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('filters the full catalog client-side and applies limit', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(indicatorsFixture), { status: 200 })) as typeof fetch;
    const out = await worldbankSearch('inflation', 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'FP.CPI.TOTL.ZG');
  });

  await t.test('returns [] when nothing matches', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(indicatorsFixture), { status: 200 })) as typeof fetch;
    const out = await worldbankSearch('zzznonexistentzzz', 5);
    assert.deepEqual(out, []);
  });
});

test('worldbankRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('renders the recent series as text, dropping null observations', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(seriesFixture), { status: 200 })) as typeof fetch;
    const result = await worldbankRead('FP.CPI.TOTL.ZG');
    assert.equal(result.title, 'Inflation, consumer prices (annual %)');
    assert.match(result.text, /Africa Eastern and Southern \(2025\): 4\.27/);
    assert.ok(!result.text.includes('North America (2025): null'));
  });

  await t.test('throws when the indicator has no data', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ total: 0 }, []]), { status: 200 })) as typeof fetch;
    await assert.rejects(() => worldbankRead('NONEXISTENT'), /not found or has no data/);
  });
});

test('worldbank adapter is registered', () => {
  assert.ok(getAdapter('worldbank'));
});
