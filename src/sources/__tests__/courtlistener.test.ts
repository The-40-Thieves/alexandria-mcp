import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { courtlistenerSearch, normalizeCourtlistener } from '../courtlistener.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/courtlistener-search.json'), 'utf8'),
);

test('normalizeCourtlistener', async (t) => {
  await t.test('maps /search/?type=o results', () => {
    const out = normalizeCourtlistener(fixture);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '9506311');
    assert.equal(out[0].title, 'Brown v. Board of Education');
    assert.equal(out[0].year, 1954);
    assert.deepEqual(out[0].subjects, ['scotus']);
    assert.equal(
      out[0].previewUrl,
      'https://www.courtlistener.com/opinion/9506311/brown-v-board-of-education/',
    );
  });
});

test('courtlistenerSearch throws a clear "requires COURTLISTENER_API_KEY" error when unconfigured', async () => {
  const saved = process.env.COURTLISTENER_API_KEY;
  delete process.env.COURTLISTENER_API_KEY;
  try {
    await assert.rejects(courtlistenerSearch('brown', 5), /requires COURTLISTENER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.COURTLISTENER_API_KEY = saved;
  }
});
