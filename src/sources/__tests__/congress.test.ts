import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { billId, normalizeCongressBill } from '../congress.js';
import { getAdapter } from '../registry.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/congress-bills.json'), 'utf8'),
);

test('billId', async (t) => {
  await t.test('builds a lowercase congress-type-number id', () => {
    assert.equal(billId(fixture.bills[0]), '119-hr-4465');
  });
});

test('normalizeCongressBill', async (t) => {
  await t.test('maps a bill to a LibraryResult', () => {
    const out = normalizeCongressBill(fixture.bills[0]);
    assert.equal(out.id, '119-hr-4465');
    assert.equal(out.source, 'congress');
    assert.ok(out.title.includes('title 5'));
    assert.equal(out.year, 2025);
    assert.ok(out.description?.includes('Motion to reconsider'));
  });
});

test('congress requires DATA_GOV_API_KEY (or GOVINFO_API_KEY)', async (t) => {
  const savedDataGov = process.env.DATA_GOV_API_KEY;
  const savedGovinfo = process.env.GOVINFO_API_KEY;
  t.after(() => {
    if (savedDataGov === undefined) delete process.env.DATA_GOV_API_KEY;
    else process.env.DATA_GOV_API_KEY = savedDataGov;
    if (savedGovinfo === undefined) delete process.env.GOVINFO_API_KEY;
    else process.env.GOVINFO_API_KEY = savedGovinfo;
  });

  await t.test('throws "congress requires DATA_GOV_API_KEY" when both envs are absent', async () => {
    delete process.env.DATA_GOV_API_KEY;
    delete process.env.GOVINFO_API_KEY;
    await assert.rejects(
      () => getAdapter('congress').search('privacy', 5),
      /^Error: congress requires DATA_GOV_API_KEY$/,
    );
  });
});
