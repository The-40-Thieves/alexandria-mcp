import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { normalizeReliefweb } from '../reliefweb.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/reliefweb-reports.json'), 'utf8'),
);

test('normalizeReliefweb', async (t) => {
  await t.test('maps a report to a LibraryResult', () => {
    const out = normalizeReliefweb(fixture.data[0]);
    assert.equal(out.id, '4012345');
    assert.equal(out.source, 'reliefweb');
    assert.ok(out.title.includes('Sudan'));
    assert.equal(out.year, 2026);
    assert.equal(out.hasFullText, true);
    assert.equal(
      out.url,
      'https://reliefweb.int/report/sudan/humanitarian-response-situation-report',
    );
  });
});

test('reliefweb requires RELIEFWEB_APPNAME', async (t) => {
  const originalEnv = process.env.RELIEFWEB_APPNAME;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.RELIEFWEB_APPNAME;
    else process.env.RELIEFWEB_APPNAME = originalEnv;
  });

  await t.test('throws "reliefweb requires RELIEFWEB_APPNAME" when the env is absent', async () => {
    delete process.env.RELIEFWEB_APPNAME;
    await assert.rejects(
      () => getAdapter('reliefweb').search('sudan', 5),
      /^Error: reliefweb requires RELIEFWEB_APPNAME$/,
    );
  });
});
