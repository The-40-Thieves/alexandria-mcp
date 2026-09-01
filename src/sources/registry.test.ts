import { describe, it } from 'node:test';
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { truncateText, READ_MAX_CHARS, register, listSources, catalog, getAdapter } from './registry.js';

describe('truncateText', () => {
  it('returns exact string if below max limit', () => {
    const text = 'Hello world';
    const result = truncateText(text);
    assert.deepEqual(result, {
      text: 'Hello world',
      charCount: 11,
      truncated: false,
      truncatedAt: undefined,
    });
  });

  it('returns exact string if exactly at max limit', () => {
    const text = 'a'.repeat(READ_MAX_CHARS);
    const result = truncateText(text);
    assert.deepEqual(result, {
      text,
      charCount: READ_MAX_CHARS,
      truncated: false,
      truncatedAt: undefined,
    });
  });

  it('truncates string if above max limit', () => {
    const overflow = 50;
    const text = 'a'.repeat(READ_MAX_CHARS) + 'b'.repeat(overflow);
    const result = truncateText(text);
    assert.deepEqual(result, {
      text: 'a'.repeat(READ_MAX_CHARS),
      charCount: READ_MAX_CHARS + overflow,
      truncated: true,
      truncatedAt: READ_MAX_CHARS,
    });
  });
});

test('registry v2', async (t) => {
  await t.test('applies defaults and exposes metadata', () => {
    register('t_defaults', {
      description: 'x',
      supportsIngest: false,
      async search() { return []; },
      async read() { return { title: '', authors: [] }; },
    });
    const s = listSources().find(x => x.name === 't_defaults')!;
    assert.equal(s.kind, 'rest');
    assert.equal(s.freshness, 'static');
    assert.equal(s.timeoutMs, 15000);
  });

  await t.test('keyed source without env is hidden from catalog but still resolvable', () => {
    delete process.env.T_KEY;
    register('t_keyed', {
      description: 'x',
      supportsIngest: false,
      auth: { type: 'query', env: 'T_KEY', param: 'key' },
      async search() { return []; },
      async read() { return { title: '', authors: [] }; },
    });
    assert.ok(!catalog().some(c => c.name === 't_keyed'));
    assert.ok(getAdapter('t_keyed'));
  });
});
