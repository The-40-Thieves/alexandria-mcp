import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { coreSearch, normalizeCore } from '../core.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/core-search.json'), 'utf8'),
);

test('normalizeCore', async (t) => {
  await t.test('maps CORE v3 /search/works results', () => {
    const out = normalizeCore(fixture);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '84371635');
    assert.equal(out[0].title, 'Attention Is All You Need');
    assert.deepEqual(out[0].authors, ['Ashish Vaswani', 'Noam Shazeer']);
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[0].previewUrl, 'https://core.ac.uk/download/84371635.pdf');
  });

  await t.test('handles a work with no authors/abstract', () => {
    const out = normalizeCore(fixture);
    assert.deepEqual(out[1].authors, []);
    assert.equal(out[1].hasFullText, false);
  });
});

test('coreSearch throws a clear "requires CORE_API_KEY" error when unconfigured', async () => {
  const saved = process.env.CORE_API_KEY;
  delete process.env.CORE_API_KEY;
  try {
    await assert.rejects(coreSearch('science', 5), /requires CORE_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.CORE_API_KEY = saved;
  }
});
