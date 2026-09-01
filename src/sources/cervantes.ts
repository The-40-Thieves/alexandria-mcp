import { parse } from 'node-html-parser';
import { fetchText } from '../utils/http.js';
import { normaliseWhitespace, stripHtml } from '../utils/text-clean.js';
import type { LibraryResult } from '../types.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.cervantesvirtual.com';
const SEARCH = `${BASE}/buscador/`;

// The Cervantes Virtual Library has a search engine
// Results come as HTML — we scrape the search results page.

export async function cervantesSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    tipo: 'texto',
    rows: String(limit),
  });

  const html = await fetchText(`${SEARCH}?${params}`);
  const root = parse(html);

  const items = root.querySelectorAll('.result-item, article.resultado, .item-resultado').slice(0, limit);
  if (items.length === 0) {
    // Fallback: curated catalog
    return cervantessCatalogSearch(query, limit);
  }

  return items.map(el => {
    const titleEl = el.querySelector('a.titulo, h2 a, h3 a, .title a');
    const title = titleEl?.text?.trim() ?? '';
    const href = titleEl?.getAttribute('href') ?? '';
    const authEl = el.querySelector('.autor, .creator, .author');
    const author = authEl?.text?.trim() ?? '';
    const dateEl = el.querySelector('.fecha, .date, .year');
    const year = dateEl?.text?.trim() ? parseInt(dateEl.text.trim(), 10) : undefined;
    const id = href.replace(BASE, '').replace(/^\//, '');

    return {
      id: id || title,
      source: 'cervantes' as const,
      title,
      authors: author ? [author] : [],
      year: isNaN(year ?? NaN) ? undefined : year,
      language: 'es',
      subjects: ['Spanish literature'],
      hasFullText: true,
      previewUrl: href.startsWith('http') ? href : `${BASE}${href}`,
    };
  });
}

const CURATED: Array<{
  id: string; title: string; authors: string[]; year?: number;
  language: string; subjects: string[]; url: string;
}> = [
  { id: 'quijote', title: 'Don Quijote de la Mancha', authors: ['Miguel de Cervantes'], year: 1605, language: 'es', subjects: ['Spanish literature', 'Novel', 'Siglo de Oro'], url: `${BASE}/obra/el-ingenioso-hidalgo-don-quijote-de-la-mancha--0/` },
  { id: 'lorca-romancero', title: 'Romancero Gitano', authors: ['Federico García Lorca'], year: 1928, language: 'es', subjects: ['Spanish poetry', 'Andalusia'], url: `${BASE}/obra/romancero-gitano/` },
  { id: 'neruda-veinte', title: 'Veinte poemas de amor', authors: ['Pablo Neruda'], year: 1924, language: 'es', subjects: ['Spanish-American poetry', 'Love poetry'], url: `${BASE}/obra/veinte-poemas-de-amor-y-una-cancion-desesperada/` },
  { id: 'borges-ficciones', title: 'Ficciones', authors: ['Jorge Luis Borges'], year: 1944, language: 'es', subjects: ['Argentine literature', 'Short stories', 'Magical realism'], url: `${BASE}/obra/ficciones/` },
  { id: 'rulfo-llano-llamas', title: 'El llano en llamas', authors: ['Juan Rulfo'], year: 1953, language: 'es', subjects: ['Mexican literature', 'Short stories'], url: `${BASE}/obra/el-llano-en-llamas/` },
  { id: 'calderon-vida-sueno', title: 'La vida es sueño', authors: ['Pedro Calderón de la Barca'], year: 1636, language: 'es', subjects: ['Spanish drama', 'Siglo de Oro', 'Baroque'], url: `${BASE}/obra/la-vida-es-sueno/` },
  { id: 'san-juan-noche-oscura', title: 'Noche Oscura del Alma', authors: ['San Juan de la Cruz'], year: 1618, language: 'es', subjects: ['Spanish mysticism', 'Poetry', 'Carmelite'], url: `${BASE}/obra/obras-de-san-juan-de-la-cruz/` },
];

function cervantessCatalogSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);
  return CURATED
    .filter(e => terms.some(t => [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase().includes(t)))
    .slice(0, limit)
    .map(e => ({
      id: e.id, source: 'cervantes' as const,
      title: e.title, authors: e.authors, year: e.year,
      language: e.language, subjects: e.subjects,
      hasFullText: true, previewUrl: e.url,
    }));
}

export async function cervantesRead(id: string): Promise<{
  text: string; title: string; authors: string[]; language?: string;
}> {
  const entry = CURATED.find(e => e.id === id);
  let url = entry?.url ?? (id.startsWith('http') ? id : `${BASE}/${id}`);
  if (url.startsWith('http') && !url.startsWith(BASE)) {
      throw new Error(`Invalid URL: ${url}`);
  }

  const html = await fetchText(url);
  const root = parse(html);

  // Find the text content div
  for (const el of root.querySelectorAll('script, style, nav, header, footer, .nav, .header, .footer, .sidebar')) {
    el.remove();
  }

  const content = root.querySelector('.texto, .text-content, article, main, #content') ?? root.querySelector('body');
  const text = normaliseWhitespace(content?.text ?? stripHtml(html));

  return {
    text,
    title: entry?.title ?? id,
    authors: entry?.authors ?? [],
    language: entry?.language ?? 'es',
  };
}

register('cervantes', {
  description: 'Cervantes Virtual Library — Spanish and Portuguese literature. Cervantes, Borges, Lorca, Neruda, Rulfo, Calderón, San Juan de la Cruz.',
  supportsIngest: true,
  search: cervantesSearch,
  async read(id) {
    const raw = await cervantesRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
