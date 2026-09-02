import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { normaliseWhitespace } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.marxists.org';

// MIA has a catalog JSON endpoint for search
const CATALOG_URL = `${BASE}/admin/newlookup/search/`;

interface MIADoc {
  text: string;
  url: string;
  title: string;
  author: string;
  date: string;
  description: string;
}

export async function marxistsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  try {
    const data = await fetchJSON<MIADoc[]>(
      `${CATALOG_URL}?q=${encodeURIComponent(query)}&format=json&rows=${limit}`,
    );
    return (data ?? []).slice(0, limit).map((doc) => ({
      id: doc.url,
      source: 'marxists' as const,
      title: doc.title,
      authors: doc.author ? [doc.author] : [],
      year: doc.date ? parseInt(doc.date, 10) : undefined,
      subjects: [],
      hasFullText: true,
      previewUrl: doc.url.startsWith('http') ? doc.url : `${BASE}${doc.url}`,
    }));
  } catch {
    // Fallback: curated catalog
    return marxistsCatalogSearch(query, limit);
  }
}

// Curated fallback for when the search API is down
const CURATED: Array<{
  id: string;
  title: string;
  authors: string[];
  year?: number;
  subjects: string[];
  url: string;
}> = [
  {
    id: 'marx-communist-manifesto',
    title: 'The Communist Manifesto',
    authors: ['Karl Marx', 'Friedrich Engels'],
    year: 1848,
    subjects: ['Marxism', 'Political theory'],
    url: `${BASE}/archive/marx/works/1848/communist-manifesto/`,
  },
  {
    id: 'marx-capital-v1',
    title: 'Capital Volume I',
    authors: ['Karl Marx'],
    year: 1867,
    subjects: ['Marxism', 'Economics', 'Capital'],
    url: `${BASE}/archive/marx/works/1867-c1/`,
  },
  {
    id: 'gramsci-prison-notebooks',
    title: 'Prison Notebooks (selections)',
    authors: ['Antonio Gramsci'],
    year: 1971,
    subjects: ['Marxism', 'Hegemony', 'Cultural theory'],
    url: `${BASE}/archive/gramsci/prison_notebooks/`,
  },
  {
    id: 'luxemburg-accumulation',
    title: 'The Accumulation of Capital',
    authors: ['Rosa Luxemburg'],
    year: 1913,
    subjects: ['Marxism', 'Economics', 'Imperialism'],
    url: `${BASE}/archive/luxemburg/1913/accumulation-capital/`,
  },
  {
    id: 'bakunin-god-state',
    title: 'God and the State',
    authors: ['Mikhail Bakunin'],
    year: 1882,
    subjects: ['Anarchism', 'Political theory'],
    url: `${BASE}/reference/archive/bakunin/works/godstate/`,
  },
  {
    id: 'kropotkin-mutual-aid',
    title: 'Mutual Aid: A Factor of Evolution',
    authors: ['Pyotr Kropotkin'],
    year: 1902,
    subjects: ['Anarchism', 'Evolution'],
    url: `${BASE}/reference/archive/kropotkin/1902/mutual-aid/`,
  },
  {
    id: 'debord-society-spectacle',
    title: 'The Society of the Spectacle',
    authors: ['Guy Debord'],
    year: 1967,
    subjects: ['Situationism', 'Media theory'],
    url: `${BASE}/reference/archive/debord/society.htm`,
  },
  {
    id: 'fanon-wretched-earth',
    title: 'The Wretched of the Earth',
    authors: ['Frantz Fanon'],
    year: 1961,
    subjects: ['Anti-colonialism', 'Decolonization'],
    url: `${BASE}/subject/africa/fanon/wretched.htm`,
  },
  {
    id: 'benjamin-work-art',
    title: 'The Work of Art in the Age of Mechanical Reproduction',
    authors: ['Walter Benjamin'],
    year: 1935,
    subjects: ['Critical theory', 'Art', 'Media'],
    url: `${BASE}/reference/archive/benjamin/1936/work-of-art/`,
  },
];

function marxistsCatalogSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);
  return CURATED.filter((e) => {
    const hay = [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase();
    return terms.some((t) => hay.includes(t));
  })
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      source: 'marxists' as const,
      title: e.title,
      authors: e.authors,
      year: e.year,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: e.url,
    }));
}

export async function marxistsRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
}> {
  const entry = CURATED.find((e) => e.id === id);
  const url = entry?.url ?? (id.startsWith('http') ? id : `${BASE}${id}`);
  if (url.startsWith('http') && !url.startsWith(BASE)) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const html = await fetchText(url);
  const root = parse(html);
  for (const el of root.querySelectorAll('script, style, .navigation, .updat, .footer, table'))
    el.remove();
  const body = root.querySelector('body');
  const text = normaliseWhitespace(body?.text ?? '');

  return { text, title: entry?.title ?? url, authors: entry?.authors ?? [] };
}

register('marxists', {
  description:
    'Marxists Internet Archive — socialist, anarchist, and critical theory texts. Marx, Engels, Luxemburg, Gramsci, Fanon, Benjamin, and 700+ authors.',
  supportsIngest: true,
  kind: 'scrape',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://www.marxists.org',
  verifiedAt: '2026-09-01',
  search: marxistsSearch,
  async read(id) {
    const raw = await marxistsRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
