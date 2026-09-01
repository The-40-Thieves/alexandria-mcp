import assert from 'node:assert/strict';
import test from 'node:test';
import { recordFullTextRead, resetFullTextWindow } from '../trove.js';

test('trove full-text cap', async (t) => {
  await t.test('allows reads up to the cap and rejects the next one', () => {
    const t0 = 1_000_000;
    resetFullTextWindow(t0);
    for (let i = 1; i <= 25; i++) assert.equal(recordFullTextRead(t0 + i), i);
    assert.throws(() => recordFullTextRead(t0 + 26), /cap reached \(25 per session\)/);
  });

  await t.test('resets after the 24-hour window', () => {
    const t0 = 2_000_000;
    resetFullTextWindow(t0);
    for (let i = 1; i <= 25; i++) recordFullTextRead(t0 + i);
    assert.throws(() => recordFullTextRead(t0 + 30));
    assert.equal(recordFullTextRead(t0 + 24 * 60 * 60 * 1000 + 1), 1);
  });
});
