import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

const BASE = 'https://sacred-texts.com';

// ─── Registry ──────────────────────────────────────────────────────────────
// Static index of curated texts. Avoids live crawl for search.
// To add a new text: add an entry here — the scraper does the rest.

interface RegistryEntry {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  language: string;
  subjects: string[];
  tocUrl: string;
  tradition: string; // used as a searchable tag
}

export const REGISTRY: RegistryEntry[] = [
  // ── Quran ──────────────────────────────────────────────────────────────
  {
    id: 'quran-pickthall',
    title: 'The Meaning of The Glorious Quran (Pickthall)',
    authors: ['Mohammed Marmaduke Pickthall'],
    year: 1930,
    language: 'en',
    subjects: ['Islam', 'Quran', 'Scripture', 'Translation'],
    tocUrl: `${BASE}/isl/quran/index.htm`,
    tradition: 'islam',
  },
  {
    id: 'quran-yusufali',
    title: 'The Holy Quran (Yusuf Ali)',
    authors: ['Abdullah Yusuf Ali'],
    year: 1934,
    language: 'en',
    subjects: ['Islam', 'Quran', 'Scripture', 'Translation'],
    tocUrl: `${BASE}/isl/quran/index.htm`,
    tradition: 'islam',
  },
  {
    id: 'quran-sale',
    title: 'The Koran (George Sale)',
    authors: ['George Sale'],
    year: 1734,
    language: 'en',
    subjects: ['Islam', 'Quran', 'Scripture', 'Translation'],
    tocUrl: `${BASE}/isl/quran/index.htm`,
    tradition: 'islam',
  },

  // ── Hadith ─────────────────────────────────────────────────────────────
  {
    id: 'hadith-bukhari',
    title: 'Sahih al-Bukhari',
    authors: ['Muhammad al-Bukhari'],
    year: 846,
    language: 'en',
    subjects: ['Islam', 'Hadith', 'Sunnah'],
    tocUrl: `${BASE}/isl/bukhari/index.htm`,
    tradition: 'islam',
  },

  // ── Rumi ───────────────────────────────────────────────────────────────
  {
    id: 'masnavi-whinfield',
    title: 'The Masnavi of Jalaluddin Rumi (Whinfield)',
    authors: ['Jalal al-Din Rumi', 'E.H. Whinfield (trans.)'],
    year: 1898,
    language: 'en',
    subjects: ['Islam', 'Sufism', 'Rumi', 'Poetry', 'Mysticism'],
    tocUrl: `${BASE}/isl/masnavi/index.htm`,
    tradition: 'sufism',
  },
  {
    id: 'rumi-diwan',
    title: 'Diwan-i Shams-i Tabriz (Selected Poems)',
    authors: ['Jalal al-Din Rumi', 'R.A. Nicholson (trans.)'],
    year: 1898,
    language: 'en',
    subjects: ['Islam', 'Sufism', 'Rumi', 'Poetry', 'Mysticism'],
    tocUrl: `${BASE}/isl/divan/index.htm`,
    tradition: 'sufism',
  },

  // ── Al-Ghazali ─────────────────────────────────────────────────────────
  {
    id: 'ghazali-alchemy',
    title: 'The Alchemy of Happiness (Al-Ghazali)',
    authors: ['Abu Hamid al-Ghazali', 'Claud Field (trans.)'],
    year: 1909,
    language: 'en',
    subjects: ['Islam', 'Sufism', 'Al-Ghazali', 'Philosophy', 'Ethics'],
    tocUrl: `${BASE}/isl/ali/index.htm`,
    tradition: 'sufism',
  },

  // ── Ibn Arabi ──────────────────────────────────────────────────────────
  {
    id: 'tarjuman-nicholson',
    title: 'The Tarjuman Al-Ashwaq (Ibn Arabi)',
    authors: ['Muhyiddin Ibn Arabi', 'R.A. Nicholson (trans.)'],
    year: 1911,
    language: 'en',
    subjects: ['Islam', 'Sufism', 'Ibn Arabi', 'Poetry', 'Mysticism'],
    tocUrl: `${BASE}/isl/taj/index.htm`,
    tradition: 'sufism',
  },

  // ── Attar ──────────────────────────────────────────────────────────────
  {
    id: 'conference-birds',
    title: 'The Conference of the Birds (Farid ud-Din Attar)',
    authors: ['Farid ud-Din Attar', 'Edward FitzGerald (trans.)'],
    year: 1889,
    language: 'en',
    subjects: ['Islam', 'Sufism', 'Attar', 'Poetry', 'Allegory'],
    tocUrl: `${BASE}/isl/pdp/index.htm`,
    tradition: 'sufism',
  },

  // ── Hafiz ──────────────────────────────────────────────────────────────
  {
    id: 'hafiz-divan',
    title: 'The Divan of Hafiz (Bicknell)',
    authors: ['Hafiz', 'Herman Bicknell (trans.)'],
    year: 1875,
    language: 'en',
    subjects: ['Islam', 'Sufism', 'Hafiz', 'Poetry', 'Persian'],
    tocUrl: `${BASE}/isl/hafiz/index.htm`,
    tradition: 'sufism',
  },

  // ── Omar Khayyam ───────────────────────────────────────────────────────
  {
    id: 'rubaiyat-fitzgerald',
    title: 'Rubaiyat of Omar Khayyam (FitzGerald)',
    authors: ['Omar Khayyam', 'Edward FitzGerald (trans.)'],
    year: 1859,
    language: 'en',
    subjects: ['Islam', 'Poetry', 'Persian', 'Khayyam'],
    tocUrl: `${BASE}/isl/quran/index.htm`, // FitzGerald collected
    tradition: 'islam',
  },

  // ── Baha'i / Related ───────────────────────────────────────────────────
  {
    id: 'kitab-aqdas',
    title: "The Kitab-i-Aqdas (Baha'u'llah)",
    authors: ["Baha'u'llah"],
    year: 1873,
    language: 'en',
    subjects: ["Baha'i", 'Scripture', 'Law'],
    tocUrl: `${BASE}/bhi/aqdas/index.htm`,
    tradition: 'bahai',
  },

  // ── Hindu / Vedanta ────────────────────────────────────────────────────
  {
    id: 'upanishads-max-muller',
    title: 'The Upanishads (Max Muller)',
    authors: ['Max Muller (trans.)'],
    year: 1879,
    language: 'en',
    subjects: ['Hinduism', 'Vedanta', 'Upanishads', 'Philosophy'],
    tocUrl: `${BASE}/hin/sbe01/index.htm`,
    tradition: 'hinduism',
  },
  {
    id: 'bhagavad-gita',
    title: 'The Bhagavad Gita',
    authors: ['Edwin Arnold (trans.)'],
    year: 1885,
    language: 'en',
    subjects: ['Hinduism', 'Bhagavad Gita', 'Scripture', 'Philosophy'],
    tocUrl: `${BASE}/hin/gita/index.htm`,
    tradition: 'hinduism',
  },

  // ── Buddhism ───────────────────────────────────────────────────────────
  {
    id: 'dhammapada',
    title: 'The Dhammapada',
    authors: ['Max Muller (trans.)'],
    year: 1881,
    language: 'en',
    subjects: ['Buddhism', 'Dhammapada', 'Pali Canon', 'Ethics'],
    tocUrl: `${BASE}/bud/sbe10/index.htm`,
    tradition: 'buddhism',
  },
  {
    id: 'tibetan-book-dead',
    title: 'The Tibetan Book of the Dead',
    authors: ['W.Y. Evans-Wentz (trans.)'],
    year: 1927,
    language: 'en',
    subjects: ['Buddhism', 'Tibet', 'Death', 'Bardo', 'Mysticism'],
    tocUrl: `${BASE}/bud/bardo/index.htm`,
    tradition: 'buddhism',
  },

  // ── Taoism ─────────────────────────────────────────────────────────────
  {
    id: 'tao-te-ching',
    title: 'Tao Te Ching (Legge)',
    authors: ['Lao Tzu', 'James Legge (trans.)'],
    year: 1891,
    language: 'en',
    subjects: ['Taoism', 'Lao Tzu', 'Philosophy', 'Chinese'],
    tocUrl: `${BASE}/tao/taote.htm`,
    tradition: 'taoism',
  },

  // ── Gnosticism / Hermeticism ───────────────────────────────────────────
  {
    id: 'kybalion',
    title: 'The Kybalion',
    authors: ['Three Initiates'],
    year: 1908,
    language: 'en',
    subjects: ['Hermeticism', 'Occult', 'Philosophy', 'Mysticism'],
    tocUrl: `${BASE}/eso/kyb/index.htm`,
    tradition: 'hermeticism',
  },
  {
    id: 'nag-hammadi-gospel-thomas',
    title: 'Gospel of Thomas (Nag Hammadi)',
    authors: ['Thomas', 'Various'],
    year: 1977,
    language: 'en',
    subjects: ['Gnosticism', 'Christianity', 'Nag Hammadi', 'Gospel'],
    tocUrl: `${BASE}/chr/apo/thomas.htm`,
    tradition: 'gnosticism',
  },

  // ── Christianity (early / mystical) ────────────────────────────────────
  {
    id: 'cloud-unknowing',
    title: 'The Cloud of Unknowing',
    authors: ['Anonymous'],
    language: 'en',
    subjects: ['Christianity', 'Mysticism', 'Contemplative', 'Medieval'],
    tocUrl: `${BASE}/chr/cou/index.htm`,
    tradition: 'christianity',
  },
  {
    id: 'dark-night-soul',
    title: 'Dark Night of the Soul (John of the Cross)',
    authors: ['John of the Cross', 'David Lewis (trans.)'],
    year: 1864,
    language: 'en',
    subjects: ['Christianity', 'Mysticism', 'Contemplative', 'Spanish'],
    tocUrl: `${BASE}/chr/dns/index.htm`,
    tradition: 'christianity',
  },
];

// ─── Search ────────────────────────────────────────────────────────────────

export function sacredTextsSearch(query: string, limit = 10): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = REGISTRY.map((entry) => {
    const haystack = [
      entry.title,
      ...entry.authors,
      ...entry.subjects,
      entry.tradition,
      String(entry.year ?? ''),
    ]
      .join(' ')
      .toLowerCase();

    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);

    return { entry, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ entry }) => ({
    id: entry.id,
    source: 'sacredtexts' as const,
    title: entry.title,
    authors: entry.authors,
    year: entry.year,
    language: entry.language,
    subjects: entry.subjects,
    hasFullText: true,
    previewUrl: entry.tocUrl,
  }));
}

// sacred-texts.com returns HTTP 403 to unauthenticated/automated requests
// (confirmed live 2026-09, the whole site is bot-gated, not just this
// scraper's request shape). read() no longer attempts to scrape it; the
// curated registry search still works entirely offline.
register('sacredtexts', {
  description:
    'Sacred-Texts.com: curated registry of religious/philosophical texts: Quran, Sufi corpus, Vedanta, Buddhism, Taoism, Hermeticism, Christian mysticism. The live site is bot-gated (HTTP 403); read() returns metadata only.',
  supportsIngest: true,
  kind: 'scrape',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://sacred-texts.com',
  verifiedAt: '2026-09-01',
  search: (query, limit) => Promise.resolve(sacredTextsSearch(query, limit)),
  async read(id) {
    const entry = REGISTRY.find((e) => e.id === id);
    if (!entry) {
      const ids = REGISTRY.map((e) => e.id).join(', ');
      throw new Error(
        `Unknown Sacred Texts ID: "${id}". ` +
          `Valid IDs: ${ids}. ` +
          `Use library_search with source="sacredtexts" to find available texts.`,
      );
    }
    return {
      title: entry.title,
      authors: entry.authors,
      year: entry.year,
      language: entry.language,
      metadataOnly: true,
      externalUrl: entry.tocUrl,
      note: 'sacred-texts.com returns HTTP 403 to automated requests (bot-gated); full text is not fetchable. Visit externalUrl directly in a browser.',
    };
  },
});
