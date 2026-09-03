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

// A minimum sample size before the lexicon check is trusted to say
// anything: a chunk that is mostly a table of numbers, a citation list, or
// a run of punctuation naturally has few or no Latin word tokens to check,
// and that is a property of the content (task 11's "per-chunk digit and
// punctuation ratios"), not evidence of garbled OCR - so below this many
// checkable tokens the lexicon score defaults to clean instead of letting
// one unlucky word (or zero words) swing the whole chunk.
const MIN_CHECKABLE_TOKENS = 3;

// A token only goes through the lexicon check when it's checkable at all:
// an ALL-CAPS run is left alone (acronyms like "ASCII" or "NASA" are not
// garbage, and a 5,000-word lexicon built from ordinary prose will never
// contain them anyway), and a token with no ASCII Latin letter at all
// (Greek/Arabic/Chinese/...) is outside what an English word list can
// judge one way or the other.
function isCheckable(token: string): boolean {
  return /[a-z]/i.test(token) && token !== token.toUpperCase();
}

// Lexicon-hit ratio: of the chunk's checkable (mixed-/lower-case Latin)
// word tokens, what fraction are one of the 5,000 most common English
// words (src/utils/data/common-english-words.ts)? This catches the OCR
// failure mode the character-class ratio below is blind to: a run of
// letters that individually look clean (right script, right case) but
// don't spell real words ("kjhsdf oiuqwer zxcvbnm"), which a misrecognized
// scan produces just as readily as legible text does not.
function lexiconScore(text: string): number {
  const tokens = text.match(/\p{L}+/gu) ?? [];
  let checkable = 0;
  let hits = 0;
  for (const token of tokens) {
    if (!isCheckable(token)) continue;
    checkable += 1;
    if (LEXICON.has(token.toLowerCase())) hits += 1;
  }
  return checkable < MIN_CHECKABLE_TOKENS ? 1 : hits / checkable;
}

// OCR quality score: the minimum of two independent 0.0-1.0 signals -
// the character-class ratio (unchanged: the fraction of characters that
// are letters, digits, whitespace or ordinary punctuation) and
// lexiconScore() above. Neither alone is enough: a language the lexicon
// doesn't cover would fail a lexicon-only check, and letter-soup garbage
// sails through a character-class-only check outright. Taking the minimum
// lets either signal veto a chunk without double-penalizing the same
// defect.
export function ocrQualityScore(text: string): number {
  if (!text || text.length === 0) return 0;

  const clean = (text.match(/[\p{L}\p{N}\s.,!?;:'"()\-–—]/gu) || []).length;
  const regexScore = clean / text.length;

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
