// Task 7: local bibliography export for library_citations. BibTeX, RIS,
// and APA are all generated synchronously from a LibraryResult's own
// fields - no network calls here. library_citations.ts layers an async
// preference on top for BibTeX specifically (Crossref's own BibTeX via
// content negotiation, when the item's DOI is known and the fetch
// succeeds), but that preference lives in the tool, not here: this module
// stays a pure formatter so it's trivially testable and reusable without a
// network stub.
import type { LibraryResult } from '../types.ts';

export type BibliographyStyle = 'bibtex' | 'ris' | 'apa';

function sanitizeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '');
}

// A short, human-readable BibTeX key: first author's surname + year +
// first word of the title, falling back to source+id when authors/title
// don't yield anything usable (e.g. an OpenCitations stub with no author).
function citeKey(item: LibraryResult): string {
  const authorPart = item.authors[0]?.trim().split(/\s+/).pop() ?? '';
  const titlePart = item.title.trim().split(/\s+/)[0] ?? '';
  const key = sanitizeKey(`${authorPart}${item.year ?? ''}${titlePart}`);
  return key || sanitizeKey(`${item.source}${item.id}`);
}

function itemUrl(item: LibraryResult): string | undefined {
  return item.previewUrl ?? item.url;
}

function toBibtex(item: LibraryResult): string {
  const fields: string[] = [`  title = {${item.title}}`];
  if (item.authors.length) fields.push(`  author = {${item.authors.join(' and ')}}`);
  if (item.year !== undefined) fields.push(`  year = {${item.year}}`);
  const url = itemUrl(item);
  if (url) fields.push(`  url = {${url}}`);
  fields.push(`  note = {${item.source}:${item.id}}`);
  return `@article{${citeKey(item)},\n${fields.join(',\n')}\n}`;
}

function toRis(item: LibraryResult): string {
  const lines: string[] = ['TY  - JOUR', `TI  - ${item.title}`];
  for (const author of item.authors) lines.push(`AU  - ${author}`);
  if (item.year !== undefined) lines.push(`PY  - ${item.year}`);
  const url = itemUrl(item);
  if (url) lines.push(`UR  - ${url}`);
  lines.push(`ID  - ${item.source}:${item.id}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

function toApa(item: LibraryResult): string {
  const authors = item.authors.length ? item.authors.join(', ') : item.source;
  const year = item.year !== undefined ? `(${item.year})` : '(n.d.)';
  const url = itemUrl(item);
  return `${authors} ${year}. ${item.title}.${url ? ` ${url}` : ''}`;
}

const FORMATTERS: Record<BibliographyStyle, (item: LibraryResult) => string> = {
  bibtex: toBibtex,
  ris: toRis,
  apa: toApa,
};

// Formats each item independently and joins them with a blank line -
// a valid multi-entry BibTeX/RIS file, or a plain list of APA references.
export function formatBibliography(items: LibraryResult[], style: BibliographyStyle): string {
  return items.map(FORMATTERS[style]).join('\n\n');
}
