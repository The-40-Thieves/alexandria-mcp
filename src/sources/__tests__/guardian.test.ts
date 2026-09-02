import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGuardian } from '../guardian.js';
import { getAdapter } from '../registry.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/guardian-search.json'), 'utf8'),
);

test('normalizeGuardian', async (t) => {
  await t.test('maps a search result to a LibraryResult', () => {
    const out = normalizeGuardian(fixture.response.results[0]);
    assert.equal(out.id, 'australia-news/2026/may/27/morning-mail-wednesday-ntwnfb');
    assert.equal(out.source, 'guardian');
    assert.ok(out.title.includes('Morning Mail'));
    assert.equal(out.year, 2026);
    assert.equal(out.description, "A quick summary of the day's news.");
    assert.equal(out.hasFullText, true);
  });
});

test('guardian requires GUARDIAN_API_KEY', async (t) => {
  const originalEnv = process.env.GUARDIAN_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.GUARDIAN_API_KEY;
    else process.env.GUARDIAN_API_KEY = originalEnv;
  });

  await t.test('throws "guardian requires GUARDIAN_API_KEY" when the env is absent', async () => {
    delete process.env.GUARDIAN_API_KEY;
    await assert.rejects(
      () => getAdapter('guardian').search('economy', 5),
      /^Error: guardian requires GUARDIAN_API_KEY$/,
    );
  });
});
