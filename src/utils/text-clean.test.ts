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
} from './text-clean.ts';

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
      const raw = `Welcome world, this is a clean sentence.`;
      const score = ocrQualityScore(raw);
      assert.ok(score > 0.9);
      assert.ok(score <= 1.0);
    });

    test('scores low for letter soup that is not real words (the lexicon gate)', () => {
      // Every character is a clean, in-alphabet letter (the pre-existing
      // regex score alone would pass this), but none of the tokens are
      // real English words - the failure mode the lexicon-hit ratio adds.
      const raw = `kjhsdf oiuqwer zxcvbnm asdfgh qwerty poiuyt lkjhgf mnbvcx`;
      const score = ocrQualityScore(raw);
      assert.ok(score < 0.75, `expected a low score, got ${score}`);
    });

    test('a real English sentence clears the lexicon gate', () => {
      const raw = `The old man came home with his dog and looked at the clean water near the great stone house.`;
      const score = ocrQualityScore(raw);
      assert.ok(score >= 0.75, `expected a passing score, got ${score}`);
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

    // Review round 1 (Important 2): the reviewer measured clean, real
    // prose/data scoring below the 0.75 threshold (statistics prose 0.542,
    // a JSON object 0.400, finance prose 0.737) because the lexicon is
    // 19th-century Gutenberg vocabulary and the old sample-size floor
    // looked only at raw token count, not how much of the chunk was even
    // alphabetic. Fixed by (a) skipping the lexicon score entirely when
    // alphabetic tokens are under 60% of all word-like tokens (numeric-
    // heavy chunks lean on the character-class regex alone), and (b)
    // crediting an out-of-lexicon token as a hit when it has a plausible
    // word shape (vowel present, reasonable length, no absurd repeats or
    // consonant runs, camelCase-aware).
    test('clean statistics prose clears the lexicon gate', () => {
      const raw =
        'The regression coefficient was 0.842 with a standard error of 0.031, yielding a ' +
        't-statistic of 27.16 and a p-value below 0.001. The R-squared value of 0.756 ' +
        'indicates that approximately 75.6% of the variance in the dependent variable is ' +
        'explained by the model, while the adjusted R-squared of 0.748 accounts for the ' +
        'number of predictors included in the analysis.';
      const score = ocrQualityScore(raw);
      assert.ok(score >= 0.75, `expected a passing score, got ${score}`);
    });

    test('a numeric-heavy JSON object clears the lexicon gate', () => {
      const raw =
        '{"id": 48291, "code": "SKU-2024-8871", "price": 149.99, "qty": 12, ' +
        '"total": 1799.88, "tax": 8.25, "discount": 0.15, "shipping": 9.99, ' +
        '"grandTotal": 1908.12, "timestamp": 1717029123, "lat": 37.7749, "lng": -122.4194}';
      const score = ocrQualityScore(raw);
      assert.ok(score >= 0.75, `expected a passing score, got ${score}`);
    });

    test('clean finance prose clears the lexicon gate', () => {
      const raw =
        'Quarterly revenue increased 12.4% year-over-year to $4.2 billion, driven primarily ' +
        'by a 340 basis point expansion in gross margin and a 7.8% reduction in operating ' +
        'expenses. EBITDA rose to $912 million, while free cash flow reached $618 million, ' +
        'up from $503 million in the prior-year period.';
      const score = ocrQualityScore(raw);
      assert.ok(score >= 0.75, `expected a passing score, got ${score}`);
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

// The shared stripHtml used to strip only the tags, leaving JavaScript and
// CSS rules behind as body text. arxiv.ts and govinfo.ts each carried their
// own near-copy that did handle it; both now use this one.
test('stripHtml drops script and style bodies', async (t) => {
  await t.test('removes a script body, not just its tags', () => {
    const out = stripHtml('<p>Real text.</p><script>var leak = "secret";</script>');
    assert.match(out, /Real text\./);
    assert.doesNotMatch(out, /var leak/);
    assert.doesNotMatch(out, /secret/);
  });

  await t.test('removes a style body, not just its tags', () => {
    const out = stripHtml('<style>body { color: red; }</style><p>Real text.</p>');
    assert.match(out, /Real text\./);
    assert.doesNotMatch(out, /color: red/);
  });

  await t.test('handles attributes, mixed case, and a spaced closing tag', () => {
    const out = stripHtml(
      '<SCRIPT type="text/javascript">bad()</SCRIPT ><StYlE media="all">.x{}</style><p>Kept.</p>',
    );
    assert.match(out, /Kept\./);
    assert.doesNotMatch(out, /bad\(\)/);
    assert.doesNotMatch(out, /\.x\{\}/);
  });

  await t.test('removes several scripts, keeping the prose between them', () => {
    const out = stripHtml('<script>a()</script>One.<script>b()</script>Two.');
    assert.match(out, /One\./);
    assert.match(out, /Two\./);
    assert.doesNotMatch(out, /a\(\)|b\(\)/);
  });

  await t.test('still decodes entities and strips ordinary tags', () => {
    // Tags become a single space each, so removed tags leave doubles;
    // only runs of 3+ whitespace collapse. Unchanged by this fix.
    assert.equal(stripHtml('<b>a</b> &amp; <i>b</i>'), 'a  &  b');
  });
});
