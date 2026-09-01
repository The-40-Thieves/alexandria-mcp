import * as assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  cleanArchiveText,
  cleanGenericText,
  cleanGutenbergText,
  normaliseWhitespace,
  ocrQualityScore,
  stripGutenbergWrapper,
  stripHtml,
} from './text-clean.js';

describe('text-clean utilities', () => {
  describe('stripGutenbergWrapper', () => {
    test('strips full header and footer', () => {
      const raw = `Pre-text
*** START OF THIS PROJECT GUTENBERG EBOOK TEST ***
Actual content
*** END OF THIS PROJECT GUTENBERG EBOOK TEST ***
Post-text`;
      const expected = 'Actual content';
      assert.strictEqual(stripGutenbergWrapper(raw), expected);
    });

    test('strips only header', () => {
      const raw = `Pre-text
*** START OF THE PROJECT GUTENBERG EBOOK TEST ***
Actual content`;
      const expected = 'Actual content';
      assert.strictEqual(stripGutenbergWrapper(raw), expected);
    });

    test('strips only footer', () => {
      const raw = `Actual content
*** END OF THE PROJECT GUTENBERG EBOOK TEST ***
Post-text`;
      const expected = 'Actual content';
      assert.strictEqual(stripGutenbergWrapper(raw), expected);
    });

    test('leaves plain text unchanged', () => {
      const raw = `Just some regular text.`;
      const expected = `Just some regular text.`;
      assert.strictEqual(stripGutenbergWrapper(raw), expected);
    });
  });

  describe('stripHtml', () => {
    test('removes HTML tags', () => {
      const raw = `<p>Hello <b>World</b></p>`;
      const expected = `Hello  World`;
      assert.strictEqual(stripHtml(raw), expected);
    });

    test('decodes common entities', () => {
      const raw = `Me &amp; you, &lt;less&gt;, &quot;quote&quot;, &#39;single&#39;, non&nbsp;breaking`;
      const expected = `Me & you, <less>, "quote", 'single', non breaking`;
      assert.strictEqual(stripHtml(raw), expected);
    });

    test('collapses excessive whitespace to double newlines', () => {
      const raw = `Line 1   Line 2       Line 3`;
      const expected = `Line 1\n\nLine 2\n\nLine 3`;
      assert.strictEqual(stripHtml(raw), expected);
    });
  });

  describe('normaliseWhitespace', () => {
    test('converts Windows and Mac line endings to Unix', () => {
      const raw = `Line 1\r\nLine 2\rLine 3`;
      const expected = `Line 1\nLine 2\nLine 3`;
      assert.strictEqual(normaliseWhitespace(raw), expected);
    });

    test('collapses four or more newlines to three', () => {
      const raw = `Line 1\n\n\n\n\nLine 2\n\n\n\nLine 3`;
      const expected = `Line 1\n\n\nLine 2\n\n\nLine 3`;
      assert.strictEqual(normaliseWhitespace(raw), expected);
    });

    test('trims leading and trailing whitespace', () => {
      const raw = `  \n  Hello \n  `;
      const expected = `Hello`;
      assert.strictEqual(normaliseWhitespace(raw), expected);
    });
  });

  describe('ocrQualityScore', () => {
    test('scores near 1.0 for ASCII-only text', () => {
      const raw = `Hello world, this is a clean sentence.`;
      const score = ocrQualityScore(raw);
      assert.ok(score > 0.9);
      assert.ok(score <= 1.0);
    });

    test('scores correctly for Unicode text (Greek/Arabic/Chinese)', () => {
      const greek = `Χαίρετε κόσμε`;
      const arabic = `مرحبا بالعالم`;
      const chinese = `你好世界`;

      assert.strictEqual(ocrQualityScore(greek), 1.0);
      assert.strictEqual(ocrQualityScore(arabic), 1.0);
      assert.strictEqual(ocrQualityScore(chinese), 1.0);
    });

    test('returns 0 for empty string', () => {
      assert.strictEqual(ocrQualityScore(''), 0);
    });

    test('scores low for punctuation-heavy/garbage text', () => {
      const raw = `^&*_+%^&*{}|<>\`~#@=\\/`;
      const score = ocrQualityScore(raw);
      assert.strictEqual(score, 0);
    });
  });

  describe('cleanGutenbergText', () => {
    test('combines wrapper stripping and whitespace normalisation', () => {
      const raw = `*** START OF THIS PROJECT GUTENBERG EBOOK ***\r\n\r\nLine 1\r\n\r\n\r\n\r\nLine 2\r\n*** END OF THIS PROJECT GUTENBERG EBOOK ***`;
      const expected = `Line 1\n\n\nLine 2`;
      assert.strictEqual(cleanGutenbergText(raw), expected);
    });
  });

  describe('cleanArchiveText', () => {
    test('strips HTML if it starts with < and normalises whitespace', () => {
      const raw = `<div>\n\n\n\nText\r\n</div>`;
      const expected = `Text`;
      assert.strictEqual(cleanArchiveText(raw), expected);
    });

    test('does not strip HTML if it does not start with <, but normalises whitespace', () => {
      const raw = `Just text <b>not stripped</b>\n\n\n\nMore text`;
      const expected = `Just text <b>not stripped</b>\n\n\nMore text`;
      assert.strictEqual(cleanArchiveText(raw), expected);
    });
  });

  describe('cleanGenericText', () => {
    test('normalises whitespace', () => {
      const raw = `Line 1\n\n\n\nLine 2\r\nLine 3`;
      const expected = `Line 1\n\n\nLine 2\nLine 3`;
      assert.strictEqual(cleanGenericText(raw), expected);
    });
  });
});
