import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.ts';
import { fetchText } from '../utils/http.ts';
import { normaliseWhitespace } from '../utils/text-clean.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'http://classics.mit.edu';

// Curated catalog — ICA has ~400 texts but no search API
const CATALOG: Array<{
  id: string;
  title: string;
  authors: string[];
  year?: number;
  language: string;
  subjects: string[];
  url: string;
}> = [
  {
    id: 'homer-iliad',
    title: 'The Iliad',
    authors: ['Homer', 'Samuel Butler (trans.)'],
    language: 'en',
    subjects: ['Greek literature', 'Epic poetry'],
    url: `${BASE}/Homer/iliad.mb.txt`,
  },
  {
    id: 'homer-odyssey',
    title: 'The Odyssey',
    authors: ['Homer', 'Samuel Butler (trans.)'],
    language: 'en',
    subjects: ['Greek literature', 'Epic poetry'],
    url: `${BASE}/Homer/odyssey.mb.txt`,
  },
  {
    id: 'plato-republic',
    title: 'The Republic',
    authors: ['Plato', 'Benjamin Jowett (trans.)'],
    language: 'en',
    subjects: ['Philosophy', 'Politics'],
    url: `${BASE}/Plato/republic.mb.txt`,
  },
  {
    id: 'aristotle-poetics',
    title: 'Poetics',
    authors: ['Aristotle', 'S.H. Butcher (trans.)'],
    language: 'en',
    subjects: ['Literary theory'],
    url: `${BASE}/Aristotle/poetics.mb.txt`,
  },
  {
    id: 'aristotle-nicomachean',
    title: 'Nicomachean Ethics',
    authors: ['Aristotle', 'W.D. Ross (trans.)'],
    language: 'en',
    subjects: ['Ethics', 'Philosophy'],
    url: `${BASE}/Aristotle/nicomachaen.mb.txt`,
  },
  {
    id: 'marcus-meditations',
    title: 'Meditations',
    authors: ['Marcus Aurelius', 'George Long (trans.)'],
    language: 'en',
    subjects: ['Stoicism', 'Philosophy'],
    url: `${BASE}/Marcus_Aurelius/meditations.mb.txt`,
  },
  {
    id: 'epictetus-discourses',
    title: 'Discourses',
    authors: ['Epictetus', 'George Long (trans.)'],
    language: 'en',
    subjects: ['Stoicism', 'Philosophy'],
    url: `${BASE}/Epictetus/discourses.mb.txt`,
  },
  {
    id: 'thucydides-history',
    title: 'History of the Peloponnesian War',
    authors: ['Thucydides', 'Richard Crawley (trans.)'],
    language: 'en',
    subjects: ['History', 'Greece'],
    url: `${BASE}/Thucydides/history.mb.txt`,
  },
  {
    id: 'herodotus-histories',
    title: 'The History (Histories)',
    authors: ['Herodotus', 'George Rawlinson (trans.)'],
    language: 'en',
    subjects: ['History', 'Persia'],
    url: `${BASE}/Herodotus/history.mb.txt`,
  },
  {
    id: 'virgil-aeneid',
    title: 'The Aeneid',
    authors: ['Virgil', 'John Dryden (trans.)'],
    language: 'en',
    subjects: ['Roman literature', 'Epic poetry'],
    url: `${BASE}/Virgil/aeneid.mb.txt`,
  },
  {
    id: 'sophocles-oedipus',
    title: 'Oedipus the King',
    authors: ['Sophocles', 'F. Storr (trans.)'],
    language: 'en',
    subjects: ['Greek drama', 'Tragedy'],
    url: `${BASE}/Sophocles/oedipus.mb.txt`,
  },
  {
    id: 'aeschylus-agamemnon',
    title: 'Agamemnon',
    authors: ['Aeschylus', 'E.D.A. Morshead (trans.)'],
    language: 'en',
    subjects: ['Greek drama', 'Tragedy'],
    url: `${BASE}/Aeschylus/agamemnon.mb.txt`,
  },
  {
    id: 'sun-tzu-art-of-war',
    title: 'The Art of War',
    authors: ['Sun Tzu', 'Lionel Giles (trans.)'],
    language: 'en',
    subjects: ['Military strategy', 'Chinese classics'],
    url: `${BASE}/Sunzi/artofwar.mb.txt`,
  },
  {
    id: 'machiavelli-prince',
    title: 'The Prince',
    authors: ['Niccolò Machiavelli', 'W.K. Marriott (trans.)'],
    language: 'en',
    subjects: ['Political theory', 'Renaissance'],
    url: `${BASE}/Prince/index.html`,
  },
  {
    id: 'dante-inferno',
    title: 'Inferno',
    authors: ['Dante Alighieri', 'Henry Wadsworth Longfellow (trans.)'],
    language: 'en',
    subjects: ['Italian literature', 'Epic poetry'],
    url: `${BASE}/Dante/inferno.mb.txt`,
  },
];

export function internetClassicsSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);
  return CATALOG.filter((e) => {
    const hay = [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase();
    return terms.some((t) => hay.includes(t));
  })
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      source: 'internetclassics' as const,
      title: e.title,
      authors: e.authors,
      year: e.year,
      language: e.language,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: e.url,
    }));
}

export async function internetClassicsRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
}> {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) {
    throw new Error(
      `Unknown Internet Classics ID: "${id}". Use library_search with source="internetclassics".`,
    );
  }

  const raw = await fetchText(entry.url);

  // If it's HTML, extract the text content
  let text: string;
  if (raw.trimStart().startsWith('<')) {
    const root = parse(raw);
    for (const el of root.querySelectorAll('script, style, table.nav, .nav')) el.remove();
    text = root.querySelector('body')?.text ?? raw;
  } else {
    text = raw;
  }

  return { text: normaliseWhitespace(text), title: entry.title, authors: entry.authors };
}

register('internetclassics', {
  description: 'Internet Classics Archive (MIT) — 440+ classical works in English translation.',
  supportsIngest: true,
  kind: 'scrape',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'http://classics.mit.edu',
  verifiedAt: '2026-09-01',
  search: (q, l) => Promise.resolve(internetClassicsSearch(q, l)),
  async read(id) {
    const raw = await internetClassicsRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
