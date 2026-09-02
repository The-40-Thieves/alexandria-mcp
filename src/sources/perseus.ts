import type { LibraryResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { normaliseWhitespace } from '../utils/text-clean.ts';
import { register, truncateText } from './registry.ts';

// Perseus's old CTS API (perseus.tufts.edu/hopper/CTS) is dead (connection
// refused, confirmed 2026-09). Scaife (scaife.perseus.org) is Perseus's
// current CTS reading environment; its /library/{urn}/json/ endpoint
// returns metadata + navigation instead of the old GetPassage/GetValidReff
// XML, and /library/passage/{urn}/text/ returns plain text directly (no
// TEI/XML to strip).
const SCAIFE = 'https://scaife.perseus.org';
const MAX_PASSAGES = 50; // cap to avoid hundreds of API calls

// Well-known URN prefixes for search simulation (CTS has no keyword search API)
const PERSEUS_CATALOG: Array<{
  id: string;
  title: string;
  authors: string[];
  language: string;
  subjects: string[];
  urn: string;
}> = [
  {
    id: 'iliad',
    title: 'Iliad',
    authors: ['Homer'],
    language: 'grc',
    subjects: ['Epic poetry', 'Greek literature'],
    urn: 'urn:cts:greekLit:tlg0012.tlg001',
  },
  {
    id: 'odyssey',
    title: 'Odyssey',
    authors: ['Homer'],
    language: 'grc',
    subjects: ['Epic poetry', 'Greek literature'],
    urn: 'urn:cts:greekLit:tlg0012.tlg002',
  },
  {
    id: 'republic',
    title: 'Republic',
    authors: ['Plato'],
    language: 'grc',
    subjects: ['Philosophy', 'Political theory'],
    urn: 'urn:cts:greekLit:tlg0059.tlg030',
  },
  {
    id: 'apology',
    title: 'Apology',
    authors: ['Plato'],
    language: 'grc',
    subjects: ['Philosophy', 'Socrates'],
    urn: 'urn:cts:greekLit:tlg0059.tlg002',
  },
  {
    id: 'nicomachean-ethics',
    title: 'Nicomachean Ethics',
    authors: ['Aristotle'],
    language: 'grc',
    subjects: ['Ethics', 'Philosophy'],
    urn: 'urn:cts:greekLit:tlg0086.tlg010',
  },
  {
    id: 'poetics',
    title: 'Poetics',
    authors: ['Aristotle'],
    language: 'grc',
    subjects: ['Literary theory', 'Drama'],
    urn: 'urn:cts:greekLit:tlg0086.tlg034',
  },
  {
    id: 'aeneid',
    title: 'Aeneid',
    authors: ['Virgil'],
    language: 'lat',
    subjects: ['Epic poetry', 'Roman literature'],
    urn: 'urn:cts:latinLit:phi0690.phi003',
  },
  {
    id: 'meditations',
    title: 'Meditations',
    authors: ['Marcus Aurelius'],
    language: 'grc',
    subjects: ['Stoicism', 'Philosophy'],
    urn: 'urn:cts:greekLit:tlg0558.tlg001',
  },
  {
    id: 'histories-herodotus',
    title: 'Histories',
    authors: ['Herodotus'],
    language: 'grc',
    subjects: ['History', 'Persia', 'Greece'],
    urn: 'urn:cts:greekLit:tlg0016.tlg001',
  },
  {
    id: 'peloponnesian-war',
    title: 'History of the Peloponnesian War',
    authors: ['Thucydides'],
    language: 'grc',
    subjects: ['History', 'Athens', 'Sparta'],
    urn: 'urn:cts:greekLit:tlg0003.tlg001',
  },
  {
    id: 'de-rerum-natura',
    title: 'De Rerum Natura',
    authors: ['Lucretius'],
    language: 'lat',
    subjects: ['Epicureanism', 'Physics'],
    urn: 'urn:cts:latinLit:phi0550.phi001',
  },
  {
    id: 'antigone',
    title: 'Antigone',
    authors: ['Sophocles'],
    language: 'grc',
    subjects: ['Drama', 'Tragedy'],
    urn: 'urn:cts:greekLit:tlg0011.tlg001',
  },
  {
    id: 'oedipus-rex',
    title: 'Oedipus Rex',
    authors: ['Sophocles'],
    language: 'grc',
    subjects: ['Drama', 'Tragedy'],
    urn: 'urn:cts:greekLit:tlg0011.tlg004',
  },
  {
    id: 'enchiridion',
    title: 'Enchiridion',
    authors: ['Epictetus'],
    language: 'grc',
    subjects: ['Stoicism', 'Philosophy'],
    urn: 'urn:cts:greekLit:tlg0557.tlg002',
  },
];

export function perseusSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);

  return PERSEUS_CATALOG.filter((e) => {
    const haystack = [e.title, ...e.authors, ...e.subjects, e.language].join(' ').toLowerCase();
    return terms.some((t) => haystack.includes(t));
  })
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      source: 'perseus' as const,
      title: e.title,
      authors: e.authors,
      language: e.language,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: `${SCAIFE}/library/${e.urn}/`,
    }));
}

interface ScaifeTocEntry {
  urn: string;
  text_url: string;
  label?: string;
  num?: string;
}

interface ScaifeWorkJson {
  urn: string;
  texts?: Array<{ urn: string }>; // work-level: pick an edition
  toc?: ScaifeTocEntry[]; // edition-level: passage navigation
  text_url?: string;
}

async function resolveEditionUrn(urn: string): Promise<string> {
  const data = await fetchJSON<ScaifeWorkJson>(`${SCAIFE}/library/${urn}/json/`);
  return data.texts?.[0]?.urn ?? urn;
}

export async function perseusRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
}> {
  const entry = PERSEUS_CATALOG.find((e) => e.id === id);
  if (!entry) {
    const ids = PERSEUS_CATALOG.map((e) => e.id).join(', ');
    throw new Error(`Unknown Perseus ID: "${id}". Valid IDs: ${ids}`);
  }

  const editionUrn = await resolveEditionUrn(entry.urn);
  const edition = await fetchJSON<ScaifeWorkJson>(`${SCAIFE}/library/${editionUrn}/json/`);
  const toc = (edition.toc ?? []).slice(0, MAX_PASSAGES);

  if (toc.length === 0) {
    const text = await fetchText(
      `${SCAIFE}${edition.text_url ?? `/library/passage/${editionUrn}/text/`}`,
    );
    return {
      text: normaliseWhitespace(text),
      title: entry.title,
      authors: entry.authors,
      language: entry.language,
    };
  }

  const parts: string[] = [];
  for (const passage of toc) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const text = await fetchText(`${SCAIFE}${passage.text_url}`);
      if (text.trim().length > 20) {
        const label = [passage.label, passage.num].filter(Boolean).join(' ');
        parts.push(label ? `\n\n# ${label}\n\n${text}` : text);
      }
    } catch {
      /* skip bad passage */
    }
  }

  return {
    text: normaliseWhitespace(parts.join('\n')),
    title: entry.title,
    authors: entry.authors,
    language: entry.language,
  };
}

register('perseus', {
  description:
    'Perseus Digital Library: classical Greek, Latin, and Arabic texts with translations, served via the Scaife reading environment.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://scaife.perseus.org',
  verifiedAt: '2026-09-01',
  search: (query, limit) => Promise.resolve(perseusSearch(query, limit)),
  async read(id) {
    const raw = await perseusRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
