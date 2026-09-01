import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.js';
import { fetchText } from '../utils/http.js';

const BASE = 'https://sacred-texts.com';
const RATE_LIMIT_MS = 1200; // polite: ~50 req/min max

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ─── HTML extraction ───────────────────────────────────────────────────────

// sacred-texts.com page structure:
//   <div class="nav"> or <table> nav elements → skip
//   Main content is in the body, after the title banner
// We extract all visible paragraph text from the body, excluding nav tables.

function extractPageText(html: string): string {
  const root = parse(html);

  // Remove nav elements and script/style
  for (const el of root.querySelectorAll('table.nav, .nav, script, style, [class*="nav"]')) {
    el.remove();
  }

  // Try to find a main content div first
  const main =
    root.querySelector('#main') ||
    root.querySelector('.main') ||
    root.querySelector('div[id="body"]') ||
    root.querySelector('body');

  if (!main) return '';

  return main.text
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// Resolve a relative URL against the TOC page URL.
function resolveUrl(href: string, base: string): string {
  if (href.startsWith('http')) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    const dir = base.substring(0, base.lastIndexOf('/') + 1);
    return dir + href;
  }
}

// Fetch the TOC page, find chapter links, return ordered list.
// Chapter links are typically relative .htm links in the same directory.
// Excludes navigation and external links.
async function fetchChapterUrls(tocUrl: string): Promise<string[]> {
  const html = await fetchText(tocUrl);
  const root = parse(html);

  // Remove nav elements
  for (const el of root.querySelectorAll('table.nav, .nav, script, style')) {
    el.remove();
  }

  const tocDir = tocUrl.substring(0, tocUrl.lastIndexOf('/') + 1);

  const links = root
    .querySelectorAll('a[href]')
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => {
      if (!href || href.startsWith('#') || href.startsWith('mailto:')) return false;
      if (href.startsWith('http') && !href.startsWith(BASE)) return false;
      // Only local .htm/.html files in the same or child directory
      const lower = href.toLowerCase();
      return lower.endsWith('.htm') || lower.endsWith('.html');
    })
    .map((href) => resolveUrl(href, tocUrl))
    .filter((url) => url.startsWith(tocDir)); // same dir only

  // Deduplicate while preserving order
  return [...new Set(links)];
}

// ─── Read ──────────────────────────────────────────────────────────────────

export async function sacredTextsRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
  year?: number;
}> {
  const entry = REGISTRY.find((e) => e.id === id);
  if (!entry) {
    const ids = REGISTRY.map((e) => e.id).join(', ');
    throw new Error(
      `Unknown Sacred Texts ID: "${id}". ` +
        `Valid IDs: ${ids}. ` +
        `Use library_search with source="sacredtexts" to find available texts.`,
    );
  }

  const chapterUrls = await fetchChapterUrls(entry.tocUrl);

  if (chapterUrls.length === 0) {
    // Single-page text (e.g. Tao Te Ching)
    await sleep(RATE_LIMIT_MS);
    const html = await fetchText(entry.tocUrl);
    const text = extractPageText(html);
    return {
      text,
      title: entry.title,
      authors: entry.authors,
      language: entry.language,
      year: entry.year,
    };
  }

  // Multi-page: fetch each chapter sequentially with rate limiting
  const parts: string[] = [];

  for (let i = 0; i < chapterUrls.length; i++) {
    await sleep(RATE_LIMIT_MS);
    try {
      const html = await fetchText(chapterUrls[i]);
      const text = extractPageText(html);
      if (text.length > 50) parts.push(text);
    } catch {
      // Skip failed chapters — don't abort the whole text
    }
  }

  if (parts.length === 0) {
    throw new Error(
      `Could not extract text from any chapter of "${entry.title}". ` +
        `The site structure may have changed. Check ${entry.tocUrl}`,
    );
  }

  return {
    text: parts.join('\n\n---\n\n'),
    title: entry.title,
    authors: entry.authors,
    language: entry.language,
    year: entry.year,
  };
}

import { register, truncateText } from './registry.js';

register('sacredtexts', {
  description:
    'Sacred-Texts.com — curated registry of religious/philosophical texts: Quran, Sufi corpus, Vedanta, Buddhism, Taoism, Hermeticism, Christian mysticism.',
  supportsIngest: true,
  search: (query, limit) => Promise.resolve(sacredTextsSearch(query, limit)),
  async read(id) {
    const raw = await sacredTextsRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
