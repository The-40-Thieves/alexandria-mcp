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
// word tokens, what fraction are either in the 5,000-word lexicon
// (src/utils/data/common-english-words.ts) or otherwise look like a
// plausible word (isPlausibleToken above)? This catches the OCR failure
// mode the character-class ratio below is blind to: a run of letters that
// individually look clean (right script, right case) but don't spell
// words at all, real or plausible ("kjhsdf oiuqwer zxcvbnm"), which a
// misrecognized scan produces just as readily as legible text does not.
// Digits and punctuation never reach this function's tokens at all
// (`\p{L}+` only matches letter runs), so they never enter the ratio's
// denominator either way.
function lexiconScore(text: string): number {
  const tokens = text.match(/\p{L}+/gu) ?? [];
  let checkable = 0;
  let hits = 0;
  for (const token of tokens) {
    if (!isCheckable(token)) continue;
    checkable += 1;
    if (LEXICON.has(token.toLowerCase()) || isPlausibleToken(token)) hits += 1;
  }
  return checkable === 0 ? 1 : hits / checkable;
}

// Review round 1 (Important 2): word-like tokens are letter-runs and
// digit-runs; punctuation and whitespace are never tokens for this ratio.
// When alphabetic tokens make up less than 60% of them, the chunk is
// numeric- or symbol-heavy (a statistics table, a JSON blob, a citation
// list) rather than prose, and the lexicon check - built to judge whether
// *words* look real - has too little to work with and is skipped
// entirely, leaving the character-class ratio as the only signal.
const WORD_LIKE_RE = /\p{L}+|\p{N}+/gu;
const ALPHA_TOKEN_RE = /^\p{L}+$/u;
const MIN_ALPHA_TOKEN_RATIO = 0.6;

function isMostlyProse(text: string): boolean {
  const tokens = text.match(WORD_LIKE_RE) ?? [];
  if (tokens.length === 0) return false;
  const alphaCount = tokens.filter((t) => ALPHA_TOKEN_RE.test(t)).length;
  return alphaCount / tokens.length >= MIN_ALPHA_TOKEN_RATIO;
}

// OCR quality score: the minimum of two independent 0.0-1.0 signals - the
// character-class ratio (the fraction of characters that are letters,
// digits, whitespace or ordinary punctuation) and lexiconScore() above,
// when the chunk is prose-like enough for the latter to mean anything
// (isMostlyProse). Neither signal alone is enough: a language the lexicon
// doesn't cover would fail a lexicon-only check, and letter-soup garbage
// sails through a character-class-only check outright. Taking the minimum
// lets either signal veto a chunk without double-penalizing the same
// defect.
export function ocrQualityScore(text: string): number {
  if (!text || text.length === 0) return 0;

  const clean = (text.match(/[\p{L}\p{N}\s.,!?;:'"()\-–—]/gu) || []).length;
  const regexScore = clean / text.length;

  if (!isMostlyProse(text)) return regexScore;

  return Math.min(regexScore, lexiconScore(text));
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
