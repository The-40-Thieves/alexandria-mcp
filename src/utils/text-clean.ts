// Project Gutenberg texts have a standard header and footer
// that must be stripped before chunking.
const GUTENBERG_HEADER = /^[\s\S]*?\*{3}\s*START OF (THIS|THE) PROJECT GUTENBERG EBOOK[^\n]*\n/i;
const GUTENBERG_FOOTER = /\*{3}\s*END OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*$/i;

export function stripGutenbergWrapper(text: string): string {
  return text
    .replace(GUTENBERG_HEADER, '')
    .replace(GUTENBERG_FOOTER, '')
    .trim();
}

// Strip HTML tags, decode common entities, normalise whitespace.
// Used for Archive.org texts that come back as HTML fragments.
export function stripHtml(html: string): string {
  return html
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

// OCR quality score: ratio of "clean" characters to total.
// Returns 0.0 (garbage) to 1.0 (clean).
export function ocrQualityScore(text: string): number {
  if (!text || text.length === 0) return 0;

  const clean = (text.match(/[\p{L}\p{N}\s.,!?;:'"()\-–—]/gu) || []).length;
  return clean / text.length;
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
