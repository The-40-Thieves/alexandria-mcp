import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dplaSearch, normalizeDpla } from '../dpla.js';

// DPLA_API_KEY is required to call this live and DPLA offers no public demo
// key, so this fixture is built from DPLA's documented field reference
// (see the fixture's _source_note) rather than freshly recorded.
const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/dpla-search.json'), 'utf8'),
);

test('normalizeDpla', async (t) => {
  await t.test('maps docs[] with a single-object sourceResource.date', () => {
    const out = normalizeDpla(fixture, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '1abc2def3ghi4jkl5mno6pqr');
    assert.equal(out[0].title, 'The History of Science in the United States');
    assert.deepEqual(out[0].authors, ['Smith, Jane']);
    assert.equal(out[0].year, 1932);
    assert.equal(out[0].language, 'English');
    assert.deepEqual(out[0].subjects, ['Science--History', 'United States']);
  });

  await t.test('also accepts an array-shaped sourceResource.date', () => {
    const arrayShaped = {
      count: 1,
      docs: [{ id: 'x', sourceResource: { date: [{ begin: '2001' }] } }],
    };
    assert.equal(normalizeDpla(arrayShaped, 10)[0].year, 2001);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeDpla(fixture, 0).length, 0);
  });
});

test('dplaSearch throws a clear "requires DPLA_API_KEY" error when unconfigured', async () => {
  const saved = process.env.DPLA_API_KEY;
  delete process.env.DPLA_API_KEY;
  try {
    await assert.rejects(dplaSearch('science', 5), /requires DPLA_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.DPLA_API_KEY = saved;
  }
});
