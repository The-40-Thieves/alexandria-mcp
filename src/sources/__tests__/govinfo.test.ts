import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { govinfoSearch, normalizeGovInfo } from '../govinfo.ts';

// Recorded from the shell using GovInfo's public DEMO_KEY (per the docs at
// api.govinfo.gov/docs), never used in code, only to capture this fixture.
const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/govinfo-search.json'), 'utf8'),
);

test('normalizeGovInfo', async (t) => {
  await t.test('maps the POST /search response shape', () => {
    const out = normalizeGovInfo(fixture, 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'WCPD-2009-01-19-Pg47-2');
    assert.equal(out[0].title, 'Directive on Arctic Region Policy');
    assert.equal(out[0].year, 2009);
    assert.deepEqual(out[0].subjects, ['CPD']);
    assert.equal(out[0].hasFullText, true);
    assert.equal(
      out[0].previewUrl,
      'https://api.govinfo.gov/packages/WCPD-2009-01-19/granules/WCPD-2009-01-19-Pg47-2/summary',
    );
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeGovInfo(fixture, 1).length, 1);
  });
});

test('govinfoSearch throws a clear "requires GOVINFO_API_KEY" error when unconfigured', async () => {
  const saved = process.env.GOVINFO_API_KEY;
  delete process.env.GOVINFO_API_KEY;
  try {
    await assert.rejects(govinfoSearch('climate', 5), /requires GOVINFO_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.GOVINFO_API_KEY = saved;
  }
});
