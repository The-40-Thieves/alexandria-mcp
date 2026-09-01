import test from 'node:test';
import assert from 'node:assert/strict';
import { captionJsonUrl } from '../youtube.js';

test('captionJsonUrl', async (t) => {
  await t.test('replaces an existing fmt parameter instead of appending a second one', () => {
    const out = captionJsonUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3');
    const params = new URL(out).searchParams;
    assert.equal(params.get('fmt'), 'json3');
    assert.equal(params.getAll('fmt').length, 1);
    assert.equal(params.get('lang'), 'en');
  });

  await t.test('adds fmt when absent', () => {
    const out = captionJsonUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    assert.equal(new URL(out).searchParams.get('fmt'), 'json3');
  });
});
