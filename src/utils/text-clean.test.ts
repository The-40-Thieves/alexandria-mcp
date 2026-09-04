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
    // looked only at raw token count. Round 1's fix (skip the lexicon
    // score below 60% alphabetic tokens) turned out to have its own
    // bypasses - see Review round 2 below - so these three still exercise
    // the same real-data categories, now against the round 2 formula.
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

    test('a JSON object clears the lexicon gate', () => {
      const raw =
        '{"orderId": 48291, "customerName": "Jane Smith", "totalAmount": 149.99, ' +
        '"currency": "USD", "status": "completed", "createdAt": "2024-06-01T12:00:00Z", ' +
        '"shippingAddress": {"city": "Springfield", "country": "USA"}, "isPriority": true}';
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

    // Review round 2 (revised ruling, replaces round 1's 60%-alphabetic
    // skip): the reviewer found two ways round 1's skip let real garbage
    // through. (a) Padding a vowel-less letter-soup chunk with enough
    // digits pushed the alphabetic share under 60%, skipping the lexicon
    // check entirely and scoring the chunk 1.0 on the character-class
    // regex alone.
    test('digit-diluted vowel-less letter soup scores 0, no longer skipped', () => {
      const raw = '1 2 3 4 5 6 7 8 9 10 11 12 zxcvbnm qwrtypl bcdfgh';
      const score = ocrQualityScore(raw);
      assert.strictEqual(score, 0);
    });

    // (b) The plausible-word-shape credit (Important 2, round 1) is
    // PARTIAL (0.7), not a full hit - an English chunk whose vocabulary is
    // almost entirely unknown still fails the 0.75 threshold instead of
    // passing outright. Final wave (A): the fixture now carries the two
    // English function words ("the", "of") that put it over
    // ENGLISH_FUNCTION_WORD_MIN_SHARE, because the partial-credit lexicon
    // signal is exactly the part that is now English-only. Without them
    // this chunk is indistinguishable from clean prose in a language the
    // lexicon was never built for, which is the case A exists to fix.
    test('an English chunk of plausibly-shaped but unknown tokens scores under 0.75', () => {
      const raw =
        'the florbin wexatude glimberous plonitash fendrocal wistuvane brintolay quovendish ' +
        'frobular gantrivex mulverine trapsodine welquint braxinal dorvantle plexumeer ' +
        'scattrovin quilmadge of';
      const score = ocrQualityScore(raw);
      assert.ok(Math.abs(score - 0.73) < 1e-9, `expected ~0.73, got ${score}`);
      assert.ok(score < 0.75, 'still fails the quality threshold');
    });

    // Final wave (A): ocrQualityScore() returned min(regexScore,
    // lexiconScore) unconditionally, and the lexicon is 5,000 English
    // words - so clean prose in any other Latin-script language scored
    // 0.70 to 0.74 (measured on these exact fixtures at a066522: fr
    // 0.7375, pt 0.7257, it 0.7167, es 0.7385, de 0.6972, no 0.7057, la
    // 0.7000) against library_ingest's 0.75 threshold, silently dropping
    // every chunk from perseus, gallica, hal, eurlex and nbnorway. The
    // English lexicon veto now applies only to a chunk that is
    // confidently English by function-word share.
    const CLEAN_PROSE_BY_LANGUAGE: Array<[string, string]> = [
      [
        'French',
        "La bibliotheque nationale conserve des manuscrits rares dont plusieurs remontent au douzieme siecle. Les chercheurs qui consultent ces documents doivent respecter des regles strictes de conservation, car le papier ancien se degrade rapidement lorsqu'il est expose a la lumiere.",
      ],
      [
        'Portuguese',
        'A biblioteca nacional guarda manuscritos raros, muitos dos quais remontam ao seculo doze. Os investigadores que consultam estes documentos devem respeitar regras rigorosas de conservacao, porque o papel antigo degrada-se rapidamente quando exposto a luz.',
      ],
      [
        'Italian',
        'La biblioteca nazionale conserva manoscritti rari, molti dei quali risalgono al dodicesimo secolo. I ricercatori che consultano questi documenti devono rispettare regole rigorose di conservazione, perche la carta antica si degrada rapidamente quando viene esposta alla luce.',
      ],
      [
        'Spanish',
        'La biblioteca nacional conserva manuscritos raros, muchos de los cuales datan del siglo doce. Los investigadores que consultan estos documentos deben respetar reglas estrictas de conservacion, porque el papel antiguo se degrada rapidamente cuando se expone a la luz.',
      ],
      [
        'German',
        'Die Nationalbibliothek bewahrt seltene Handschriften auf, von denen viele aus dem zwoelften Jahrhundert stammen. Forscher, die diese Dokumente einsehen, muessen strenge Regeln zur Erhaltung beachten, weil altes Papier schnell zerfaellt, wenn es dem Licht ausgesetzt wird.',
      ],
      [
        'Norwegian',
        'Nasjonalbiblioteket oppbevarer sjeldne handskrifter, og mange av dem stammer fra det tolvte arhundret. Forskere som leser disse dokumentene ma folge strenge regler for bevaring, fordi gammelt papir brytes raskt ned nar det utsettes for lys.',
      ],
      [
        'Latin',
        'Bibliotheca nationalis codices raros servat, quorum multi ad saeculum duodecimum pertinent. Viri docti qui haec documenta inspiciunt regulas severas conservationis observare debent, quia charta vetus celeriter corrumpitur cum luci exponitur.',
      ],
      [
        'English',
        'The national library keeps rare manuscripts, many of which date from the twelfth century. Researchers who consult these documents must follow strict rules of conservation, because old paper breaks down quickly when it is exposed to the light.',
      ],
    ];

    for (const [language, prose] of CLEAN_PROSE_BY_LANGUAGE) {
      test(`clean ${language} prose clears the 0.75 ingest threshold`, () => {
        const score = ocrQualityScore(prose);
        assert.ok(score >= 0.75, `expected a passing score for ${language}, got ${score}`);
      });
    }

    // Deferred minor, folded into A's test set: "qty", "img" and "src"
    // are vowel-less, so they are neither in the lexicon nor plausibly
    // word-shaped and score 0 apiece. An otherwise ordinary English chunk
    // carrying several of them must still clear the threshold rather than
    // being dropped for using abbreviations.
    test('English prose with vowel-less abbreviations (qty, img, src) still passes', () => {
      const raw =
        'The order table lists one row per item, with the qty column holding the number ' +
        'ordered and the img column holding the src of the product photo. If the src is ' +
        'empty the page shows a placeholder, and the qty falls back to one so the total ' +
        'is never zero.';
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
