import { COMMON_ENGLISH_WORDS } from './data/common-english-words.ts';

// Project Gutenberg texts have a standard header and footer
// that must be stripped before chunking.
const GUTENBERG_HEADER = /^[\s\S]*?\*{3}\s*START OF (THIS|THE) PROJECT GUTENBERG EBOOK[^\n]*\n/i;
const GUTENBERG_FOOTER = /\*{3}\s*END OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*$/i;

export function stripGutenbergWrapper(text: string): string {
  return text.replace(GUTENBERG_HEADER, '').replace(GUTENBERG_FOOTER, '').trim();
}

// Strip HTML tags, decode common entities, normalise whitespace.
// Used wherever a source hands back an HTML fragment (Archive.org OCR,
// arxiv's HTML rendition, GovInfo package HTML).
//
// <script> and <style> bodies are removed WHOLE, before tag stripping.
// Dropping only the tags would leave the JavaScript and the CSS rules
// behind as body text, which then gets chunked, embedded and cited as if
// it were prose. This has to run first: once `<[^>]+>` has eaten the
// opening and closing tags there is nothing left to pair them by.
export function stripHtml(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

// Normalise line endings and collapse excessive blank lines.
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const LEXICON = new Set(COMMON_ENGLISH_WORDS);

// A token only enters the lexicon check when it's checkable at all: an
// ALL-CAPS run is left alone (acronyms like "ASCII" or "NASA" are not
// garbage, and a 5,000-word lexicon built from ordinary prose will never
// contain them anyway), and a token with no ASCII Latin letter at all
// (Greek/Arabic/Chinese/...) is outside what an English word list can
// judge one way or the other.
function isCheckable(token: string): boolean {
  return /[a-z]/i.test(token) && token !== token.toUpperCase();
}

// Review round 1 (Important 2): the lexicon (5,000 words from eight
// 19th/early-20th-century Gutenberg novels) doesn't contain a lot of
// perfectly ordinary modern vocabulary - statistical, financial,
// technical terms, identifiers. Rather than mis-scoring that prose as
// garbage, an out-of-lexicon token still counts as a hit when it merely
// *looks like* a real word: split on camelCase boundaries first (so
// "pValue" or "chiSquare" are judged as their parts, not as one blob),
// then every part must have at least one vowel, be 2-24 letters, never
// repeat the same letter 4+ times in a row, and never run more than five
// consonants in a row. Letter soup with no vowels at all (or a 6+
// consonant run) still fails this - see the letter-soup test fixture.
const VOWEL_RE = /[aeiou]/;
const REPEATED_LETTER_RE = /(.)\1{3,}/; // the same letter 4 or more times in a row
const LONG_CONSONANT_RUN_RE = /[^aeiou]{6,}/; // more than five consonants in a row

// camelCase -> ['camel', 'Case']; "HTTPServer" -> ['HTTP', 'Server']. A
// token with no case transition (typical prose, all-lowercase or
// all-uppercase) comes back as a single-element array, itself unchanged.
function splitCamelCase(token: string): string[] {
  return token
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
}

function hasPlausibleWordShape(segment: string): boolean {
  const s = segment.toLowerCase();
  return (
    s.length >= 2 &&
    s.length <= 24 &&
    VOWEL_RE.test(s) &&
    !REPEATED_LETTER_RE.test(s) &&
    !LONG_CONSONANT_RUN_RE.test(s)
  );
}

function isPlausibleToken(token: string): boolean {
  return splitCamelCase(token).every(hasPlausibleWordShape);
}

// Lexicon-hit ratio: of the chunk's checkable (mixed-/lower-case Latin)
// word tokens, what fraction score as real or plausible words?
// - A token in the 5,000-word lexicon (src/utils/data/common-english-
//   words.ts) counts as a full hit.
// - An out-of-lexicon token that merely looks plausible (isPlausibleToken
//   above) counts as a PARTIAL hit (PLAUSIBLE_TOKEN_WEIGHT) - Review
//   round 2's revised ruling: no skip based on how numeric/symbol-heavy
//   the chunk is (round 1's 60%-alphabetic-token skip is removed - it let
//   a vowel-less letter-soup chunk pass simply by padding it with enough
//   digits to dilute the alphabetic share under the threshold). A chunk
//   that is mostly digits/punctuation still has few checkable tokens
//   (digits/punctuation never enter this ratio's denominator - see
//   isCheckable), so it still isn't penalized for having little to check;
//   it just no longer gets a free pass on the tokens it does have.
// - A token that is neither counts as zero.
//
// Known limit, deliberately not chased here: this is a lexicon/shape
// check, not a language model. It catches letter soup (no real or
// plausible words) and symbol garbage (fails the character-class ratio),
// but a single-character OCR substitution inside otherwise real prose
// ("tbe qnick brovvn fox" for "the quick brown fox") still passes, because
// every substituted token still happens to have a vowel and a plausible
// shape. Closing that gap would need a perplexity/language model (see
// research/retrieval-sota.md section 5's n-gram/KenLM note), which is a
// materially different (and heavier) mechanism than this token-shape
// check - a deliberate next step, not a bug in this one.
const PLAUSIBLE_TOKEN_WEIGHT = 0.7;

// One pass over the chunk's checkable tokens, scored against the lexicon
// with a caller-chosen weight for the out-of-lexicon-but-plausible case.
// Two weights are used below, which is what separates the two signals
// ocrQualityScore() takes a minimum over:
//   - PLAUSIBLE_TOKEN_WEIGHT (0.7): the English lexicon signal. A token
//     the lexicon doesn't know only ever earns partial credit, so a page
//     of unknown-but-word-shaped tokens can't reach the 0.75 threshold on
//     shape alone.
//   - 1: the language-independent SHAPE signal. Word shape is all this
//     can judge about a language the lexicon was never built for, so an
//     unknown token that looks like a word counts in full.
function tokenHitRatio(tokens: string[], plausibleWeight: number): number {
  let checkable = 0;
  let weightedHits = 0;
  for (const token of tokens) {
    if (!isCheckable(token)) continue;
    checkable += 1;
    if (LEXICON.has(token.toLowerCase())) weightedHits += 1;
    else if (isPlausibleToken(token)) weightedHits += plausibleWeight;
  }
  return checkable === 0 ? 1 : weightedHits / checkable;
}

// Final wave (A): the 100 most frequent English function words, in the
// ordering the final fix-wave brief's ruling quotes from a standard
// English word-frequency list. Embedded as a constant rather than derived
// from src/utils/data/common-english-words.ts so this gate can never move
// when that Gutenberg-derived 5,000-word lexicon is regenerated - the
// lexicon answers "is this token an English word", this list answers the
// separate question "is this chunk written in English at all".
//
// Why the question needs asking: ocrQualityScore() used to apply the
// lexicon signal unconditionally, and clean French, Portuguese, Italian,
// Spanish, German, Norwegian and Latin prose scored 0.71-0.73 against
// library_ingest's 0.75 threshold - so perfectly good chunks from
// perseus, gallica, hal, eurlex and nbnorway were being dropped for being
// in the wrong language rather than for being bad OCR.
const ENGLISH_FUNCTION_WORDS = new Set([
  'the',
  'of',
  'and',
  'to',
  'in',
  'a',
  'is',
  'that',
  'for',
  'it',
  'as',
  'with',
  'was',
  'be',
  'by',
  'on',
  'not',
  'he',
  'this',
  'are',
  'or',
  'his',
  'from',
  'at',
  'which',
  'but',
  'have',
  'an',
  'had',
  'they',
  'you',
  'were',
  'their',
  'one',
  'all',
  'we',
  'can',
  'her',
  'has',
  'there',
  'been',
  'if',
  'more',
  'when',
  'will',
  'would',
  'who',
  'so',
  'no',
  'out',
  'up',
  'said',
  'what',
  'about',
  'into',
  'than',
  'them',
  'she',
  'do',
  'its',
  'time',
  'my',
  'only',
  'other',
  'new',
  'some',
  'could',
  'these',
  'two',
  'may',
  'then',
  'first',
  'any',
  'now',
  'such',
  'like',
  'our',
  'over',
  'me',
  'even',
  'most',
  'made',
  'after',
  'also',
  'did',
  'many',
  'before',
  'must',
  'through',
  'back',
  'where',
  'much',
  'your',
  'way',
  'well',
  'down',
  'should',
  'because',
  'each',
  'just',
]);

// Below this share of English function words among a chunk's alphabetic
// tokens, the chunk is not confidently English and the English lexicon
// signal is not applied to it. Ordinary English prose runs 35-50%; the
// non-English fixtures in text-clean.test.ts measure under 5%, so 8%
// separates the two with room to spare in both directions.
const ENGLISH_FUNCTION_WORD_MIN_SHARE = 0.08;

function englishFunctionWordShare(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (ENGLISH_FUNCTION_WORDS.has(token.toLowerCase())) hits += 1;
  }
  return hits / tokens.length;
}

// OCR quality score: the minimum of two independent 0.0-1.0 signals - the
// character-class ratio (the fraction of characters that are letters,
// digits, whitespace or ordinary punctuation) and a token-shape ratio.
// Neither signal alone is enough: letter-soup garbage sails through a
// character-class-only check outright, and a shape/lexicon-only check
// can't see a chunk that is mostly control bytes. Taking the minimum lets
// either signal veto a chunk without double-penalizing the same defect.
//
// Final wave (A): the token signal comes in two strengths, and which one
// applies depends on the chunk's language. The language-independent SHAPE
// ratio always applies - letter soup ("zxcvbnm", "lkjhgf") is garbage in
// every language, so the letter-soup and digit-diluted-letter-soup
// fixtures still fail here exactly as before. The stricter ENGLISH
// LEXICON ratio (where an unknown token earns only partial credit) is
// applied only to a chunk that is confidently English by
// englishFunctionWordShare() above; for anything else the lexicon has no
// standing to judge the vocabulary, and only shape and character class
// do. That is the whole fix: clean French/Latin/Portuguese prose is
// word-shaped throughout, so it now scores on its character-class ratio
// (effectively 1.0) instead of being vetoed by an English word list.
export function ocrQualityScore(text: string): number {
  if (!text || text.length === 0) return 0;

  const clean = (text.match(/[\p{L}\p{N}\s.,!?;:'"()\-–—]/gu) || []).length;
  const regexScore = clean / text.length;

  const tokens = text.match(/\p{L}+/gu) ?? [];
  const confidentlyEnglish = englishFunctionWordShare(tokens) >= ENGLISH_FUNCTION_WORD_MIN_SHARE;
  const tokenScore = tokenHitRatio(tokens, confidentlyEnglish ? PLAUSIBLE_TOKEN_WEIGHT : 1);

  return Math.min(regexScore, tokenScore);
}

// Apply all cleaning passes appropriate for a given source.
export function cleanGutenbergText(raw: string): string {
  return normaliseWhitespace(stripGutenbergWrapper(raw));
}

export function cleanArchiveText(raw: string): string {
  // Archive.org OCR text can be plain text or HTML
  const stripped = raw.startsWith('<') ? stripHtml(raw) : raw;
  return normaliseWhitespace(stripped);
}

export function cleanGenericText(raw: string): string {
  return normaliseWhitespace(raw);
}
