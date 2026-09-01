import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.js';
import { fetchText } from '../utils/http.js';
import { normaliseWhitespace } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.ccel.org';

const REGISTRY: Array<{
  id: string;
  title: string;
  authors: string[];
  year?: number;
  language: string;
  subjects: string[];
  textUrl: string;
}> = [
  // ── Augustine ───────────────────────────────────────────────────────────
  {
    id: 'augustine-confessions',
    title: 'Confessions',
    authors: ['Augustine of Hippo', 'Edward Pusey (trans.)'],
    year: 400,
    language: 'en',
    subjects: ['Patristics', 'Autobiography', 'Theology'],
    textUrl: `${BASE}/ccel/augustine/confessions.txt`,
  },
  {
    id: 'augustine-city-god',
    title: 'The City of God',
    authors: ['Augustine of Hippo', 'Marcus Dods (trans.)'],
    year: 426,
    language: 'en',
    subjects: ['Patristics', 'Political theology', 'Philosophy'],
    textUrl: `${BASE}/ccel/augustine/city_of_god.txt`,
  },
  // ── Aquinas ─────────────────────────────────────────────────────────────
  {
    id: 'aquinas-summa',
    title: 'Summa Theologica (Part I)',
    authors: ['Thomas Aquinas', 'Fathers of the English Dominican Province (trans.)'],
    year: 1274,
    language: 'en',
    subjects: ['Scholasticism', 'Theology', 'Philosophy'],
    textUrl: `${BASE}/ccel/aquinas/summa1.txt`,
  },
  // ── Calvin ──────────────────────────────────────────────────────────────
  {
    id: 'calvin-institutes',
    title: 'Institutes of the Christian Religion',
    authors: ['John Calvin', 'Henry Beveridge (trans.)'],
    year: 1536,
    language: 'en',
    subjects: ['Reformed theology', 'Calvinism', 'Protestantism'],
    textUrl: `${BASE}/ccel/calvin/institutes.txt`,
  },
  // ── Luther ──────────────────────────────────────────────────────────────
  {
    id: 'luther-bondage-will',
    title: 'The Bondage of the Will',
    authors: ['Martin Luther', 'Henry Cole (trans.)'],
    year: 1525,
    language: 'en',
    subjects: ['Lutheran theology', 'Free will', 'Reformation'],
    textUrl: `${BASE}/ccel/luther/bondage.txt`,
  },
  // ── Boethius ────────────────────────────────────────────────────────────
  {
    id: 'boethius-consolation',
    title: 'The Consolation of Philosophy',
    authors: ['Boethius', 'H.R. James (trans.)'],
    year: 524,
    language: 'en',
    subjects: ['Philosophy', 'Medieval', 'Providence'],
    textUrl: `${BASE}/ccel/boethius/consolation.txt`,
  },
  // ── Anselm ──────────────────────────────────────────────────────────────
  {
    id: 'anselm-proslogion',
    title: 'Proslogion',
    authors: ['Anselm of Canterbury', 'Sidney Norton Deane (trans.)'],
    year: 1078,
    language: 'en',
    subjects: ['Theology', 'Ontological argument', 'Philosophy'],
    textUrl: `${BASE}/ccel/anselm/basic_works.txt`,
  },
  // ── Athanasius ──────────────────────────────────────────────────────────
  {
    id: 'athanasius-incarnation',
    title: 'On the Incarnation',
    authors: ['Athanasius of Alexandria', 'Sister Penelope (trans.)'],
    year: 318,
    language: 'en',
    subjects: ['Patristics', 'Christology', 'Early church'],
    textUrl: `${BASE}/ccel/athanasius/incarnation.txt`,
  },
  // ── Wesley ──────────────────────────────────────────────────────────────
  {
    id: 'wesley-sermons',
    title: 'Sermons on Several Occasions',
    authors: ['John Wesley'],
    year: 1771,
    language: 'en',
    subjects: ['Methodist theology', 'Preaching', 'Evangelism'],
    textUrl: `${BASE}/ccel/wesley/sermons.txt`,
  },
  // ── Origen ──────────────────────────────────────────────────────────────
  {
    id: 'origen-de-principiis',
    title: 'De Principiis (On First Principles)',
    authors: ['Origen', 'Frederick Crombie (trans.)'],
    year: 230,
    language: 'en',
    subjects: ['Patristics', 'Theology', 'Early church'],
    textUrl: `${BASE}/ccel/origen/de_principiis.txt`,
  },
  // ── Spurgeon ────────────────────────────────────────────────────────────
  {
    id: 'spurgeon-treasury-david',
    title: 'The Treasury of David (Vol. 1)',
    authors: ['Charles H. Spurgeon'],
    year: 1869,
    language: 'en',
    subjects: ['Preaching', 'Psalms', 'Baptist theology'],
    textUrl: `${BASE}/ccel/spurgeon/tod1.txt`,
  },
  // ── Edwards ─────────────────────────────────────────────────────────────
  {
    id: 'edwards-religious-affections',
    title: 'Religious Affections',
    authors: ['Jonathan Edwards'],
    year: 1746,
    language: 'en',
    subjects: ['Puritan theology', 'Spirituality', 'Great Awakening'],
    textUrl: `${BASE}/ccel/edwards/affections.txt`,
  },
];

export function ccelSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);
  return REGISTRY.filter((e) =>
    terms.some((t) => [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase().includes(t)),
  )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      source: 'ccel' as const,
      title: e.title,
      authors: e.authors,
      year: e.year,
      language: e.language,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: `${BASE}/ccel/${e.id.split('-')[0]}/${e.id.split('-').slice(1).join('_')}.txt`,
    }));
}

export async function ccelRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const entry = REGISTRY.find((e) => e.id === id);
  if (!entry) {
    throw new Error(
      `Unknown CCEL ID: "${id}". Use library_search with source="ccel" to find available texts.`,
    );
  }

  await new Promise((r) => setTimeout(r, 500));
  let text: string;

  try {
    text = await fetchText(entry.textUrl);
  } catch {
    // Fallback: try HTML version
    const htmlUrl = entry.textUrl.replace('.txt', '.html');
    const html = await fetchText(htmlUrl);
    const root = parse(html);
    for (const el of root.querySelectorAll('script, style, nav, .nav, .header, .footer'))
      el.remove();
    text = root.querySelector('body')?.text ?? html;
  }

  return {
    text: normaliseWhitespace(text),
    title: entry.title,
    authors: entry.authors,
    year: entry.year,
    language: entry.language,
  };
}

register('ccel', {
  description:
    'Christian Classics Ethereal Library — patristics, Reformation theology, and Christian philosophy. Augustine, Aquinas, Calvin, Luther, Boethius, Origen, Edwards.',
  supportsIngest: true,
  search: (q, l) => Promise.resolve(ccelSearch(q, l)),
  async read(id) {
    const raw = await ccelRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
