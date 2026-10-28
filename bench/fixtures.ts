import { readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURES = path.resolve(import.meta.dirname, '../eval/fixtures');

export function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Deterministic English prose, built from a fixed vocabulary so every run
// sees the same input without shipping a large book in the repository.
const WORDS = [
  'the',
  'king',
  'went',
  'into',
  'forest',
  'and',
  'found',
  'a',
  'small',
  'house',
  'where',
  'an',
  'old',
  'woman',
  'lived',
  'with',
  'her',
  'three',
  'daughters',
  'who',
  'were',
  'very',
  'kind',
  'to',
  'every',
  'traveller',
  'that',
  'passed',
  'by',
  'river',
  'of',
  'gold',
  'he',
  'said',
  'she',
  'answered',
  'quickly',
  'because',
  'night',
  'was',
  'coming',
  'over',
  'hills',
  'they',
  'all',
  'sat',
  'down',
  'near',
  'fire',
  'listened',
];

function sentence(seed: number): string {
  const len = 8 + (seed % 12);
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(WORDS[(seed * 31 + i * 17) % WORDS.length]);
  const s = out.join(' ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

function paragraph(seed: number): string {
  const n = 3 + (seed % 5);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sentence(seed * 7 + i));
  return out.join(' ');
}

// A book-shaped text: chapters with ALL-CAPS and markdown headings and
// paragraphs separated by blank lines, the shape chunkSemantic() splits on.
export function book(chapters: number, paragraphsPerChapter: number): string {
  const parts: string[] = [];
  for (let c = 0; c < chapters; c++) {
    parts.push(c % 2 === 0 ? `CHAPTER ${c + 1}` : `## Part ${c + 1}`);
    for (let p = 0; p < paragraphsPerChapter; p++) parts.push(paragraph(c * 100 + p));
  }
  return parts.join('\n\n');
}

export function gutenbergBook(chapters: number, paragraphsPerChapter: number): string {
  return [
    'The Project Gutenberg eBook of Benchmark Tales',
    'This eBook is for the use of anyone anywhere in the United States.',
    '*** START OF THE PROJECT GUTENBERG EBOOK BENCHMARK TALES ***',
    book(chapters, paragraphsPerChapter).replace(/\n\n/g, '\r\n\r\n\r\n\r\n'),
    '*** END OF THE PROJECT GUTENBERG EBOOK BENCHMARK TALES ***',
    'Updated editions will replace the previous one.',
  ].join('\n');
}
