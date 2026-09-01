import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { truncateText, READ_MAX_CHARS } from './registry.js';

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
