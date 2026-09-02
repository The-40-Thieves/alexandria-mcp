import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { normalizeRegulations } from '../regulations.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/regulations-documents.json'), 'utf8'),
);

test('normalizeRegulations', async (t) => {
  await t.test('maps a document to a LibraryResult', () => {
    const out = normalizeRegulations(fixture.data[0]);
    assert.equal(out.id, 'NHTSA-2025-0490-0010');
    assert.equal(out.source, 'regulations');
    assert.equal(out.title, 'Climate');
    assert.equal(out.year, 2025);
    assert.equal(out.url, 'https://www.regulations.gov/document/NHTSA-2025-0490-0010');
  });
});

test('regulations requires DATA_GOV_API_KEY', async (t) => {
  const originalEnv = process.env.DATA_GOV_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.DATA_GOV_API_KEY;
    else process.env.DATA_GOV_API_KEY = originalEnv;
  });

  await t.test(
    'throws "regulations requires DATA_GOV_API_KEY" when the env is absent',
    async () => {
      delete process.env.DATA_GOV_API_KEY;
      await assert.rejects(
        () => getAdapter('regulations').search('climate', 5),
        /^Error: regulations requires DATA_GOV_API_KEY$/,
      );
    },
  );
});
