import { parse } from 'node-html-parser';
import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { normaliseWhitespace, stripHtml } from '../utils/text-clean.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.cervantesvirtual.com';
const SPARQL_ENDPOINT = 'https://data.cervantesvirtual.com/sparql';
// The linked-data graph (data.cervantesvirtual.com) — confirmed live 2026-09
// via a discovery query (`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s a ?t } }`).
// It is a Virtuoso store cataloguing works with RDA/MADS ontologies, not the
// dcterms:BibliographicResource class the original spec assumed (that class
// has zero instances in the default graph).
const GRAPH = 'http://localhost:8890/DAV/bvmc';

// The library's own /buscador/ search page used to be scraped for results,
// but its markup is unstable and frequently returns zero matches even for
// well-known works. The SPARQL endpoint over the same catalog is a more
// stable interface: filter Work labels (rdfs:label) by substring, and
// resolve each work's rdaregistry.info/Elements/w/author link to its label.
export async function cervantesSparqlSearch(
  query: string,
  limit: number,
): Promise<LibraryResult[]> {
  const escaped = query.toLowerCase().replace(/"/g, '\\"');
  const sparql = `
    SELECT ?work ?title ?authorLabel WHERE {
      GRAPH <${GRAPH}> {
        ?work a <http://rdaregistry.info/Elements/c/Work> ;
              <http://www.w3.org/2000/01/rdf-schema#label> ?title .
        OPTIONAL {
          ?work <http://rdaregistry.info/Elements/w/author> ?authorNode .
          ?authorNode <http://www.w3.org/2000/01/rdf-schema#label> ?authorLabel
        }
        FILTER(CONTAINS(LCASE(STR(?title)), "${escaped}"))
      }
    } LIMIT ${limit}`;

  const body = new URLSearchParams({ query: sparql });
  const data = await fetchJSON<CervantesSparqlResponse>(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  return normalizeCervantesSparql(data, limit);
}

interface SparqlBinding {
  work: { value: string };
  title: { value: string };
  authorLabel?: { value: string };
}
interface CervantesSparqlResponse {
  results?: { bindings?: SparqlBinding[] };
}

export function normalizeCervantesSparql(
  data: CervantesSparqlResponse,
  limit: number,
): LibraryResult[] {
  return (data.results?.bindings ?? []).slice(0, limit).map((b) => ({
    id: b.work.value,
    source: 'cervantes' as const,
    title: b.title.value,
    authors: b.authorLabel ? [b.authorLabel.value] : [],
    language: 'es',
    subjects: ['Spanish literature'],
    // The SPARQL catalog carries bibliographic metadata, not confirmed
    // scrapable full text — unlike the curated catalog below.
    hasFullText: false,
    previewUrl: b.work.value,
  }));
}

const CURATED: Array<{
  id: string;
  title: string;
  authors: string[];
  year?: number;
  language: string;
  subjects: string[];
  url: string;
}> = [
  {
    id: 'quijote',
    title: 'Don Quijote de la Mancha',
    authors: ['Miguel de Cervantes'],
    year: 1605,
    language: 'es',
    subjects: ['Spanish literature', 'Novel', 'Siglo de Oro'],
    url: `${BASE}/obra/el-ingenioso-hidalgo-don-quijote-de-la-mancha--0/`,
  },
  {
    id: 'lorca-romancero',
    title: 'Romancero Gitano',
    authors: ['Federico García Lorca'],
    year: 1928,
    language: 'es',
    subjects: ['Spanish poetry', 'Andalusia'],
    url: `${BASE}/obra/romancero-gitano/`,
  },
  {
    id: 'neruda-veinte',
    title: 'Veinte poemas de amor',
    authors: ['Pablo Neruda'],
    year: 1924,
    language: 'es',
    subjects: ['Spanish-American poetry', 'Love poetry'],
    url: `${BASE}/obra/veinte-poemas-de-amor-y-una-cancion-desesperada/`,
  },
  {
    id: 'borges-ficciones',
    title: 'Ficciones',
    authors: ['Jorge Luis Borges'],
    year: 1944,
    language: 'es',
    subjects: ['Argentine literature', 'Short stories', 'Magical realism'],
    url: `${BASE}/obra/ficciones/`,
  },
  {
    id: 'rulfo-llano-llamas',
    title: 'El llano en llamas',
    authors: ['Juan Rulfo'],
    year: 1953,
    language: 'es',
    subjects: ['Mexican literature', 'Short stories'],
    url: `${BASE}/obra/el-llano-en-llamas/`,
  },
  {
    id: 'calderon-vida-sueno',
    title: 'La vida es sueño',
    authors: ['Pedro Calderón de la Barca'],
    year: 1636,
    language: 'es',
    subjects: ['Spanish drama', 'Siglo de Oro', 'Baroque'],
    url: `${BASE}/obra/la-vida-es-sueno/`,
  },
  {
    id: 'san-juan-noche-oscura',
    title: 'Noche Oscura del Alma',
    authors: ['San Juan de la Cruz'],
    year: 1618,
    language: 'es',
    subjects: ['Spanish mysticism', 'Poetry', 'Carmelite'],
    url: `${BASE}/obra/obras-de-san-juan-de-la-cruz/`,
  },
];

function cervantesCatalogSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);
  return CURATED.filter((e) =>
    terms.some((t) => [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase().includes(t)),
  )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      source: 'cervantes' as const,
      title: e.title,
      authors: e.authors,
      year: e.year,
      language: e.language,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: e.url,
    }));
}

export async function cervantesSearch(query: string, limit: number): Promise<LibraryResult[]> {
  try {
    const sparqlResults = await cervantesSparqlSearch(query, limit);
    if (sparqlResults.length > 0) return sparqlResults;
  } catch {
    /* fall through to the curated catalog */
  }
  return cervantesCatalogSearch(query, limit);
}

export async function cervantesRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
}> {
  const entry = CURATED.find((e) => e.id === id);
  if (!entry && id.startsWith('https://data.cervantesvirtual.com/work/')) {
    // SPARQL catalog entries have no confirmed scrapable full-text page;
    // read() would need a documented text-download link this dataset
    // doesn't expose. Caller sees this as metadataOnly at the registry
    // level once wrapped — surface a clear error instead of scraping a
    // BVMC.Labs metadata page and calling that "full text".
    throw new Error(
      `Cervantes Virtual work ${id} has bibliographic metadata only via the SPARQL catalog; ` +
        `no full text is available for this id. Browse it at ${id} directly.`,
    );
  }

  const url = entry?.url ?? (id.startsWith('http') ? id : `${BASE}/${id}`);
  if (url.startsWith('http') && !url.startsWith(BASE)) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const html = await fetchText(url);
  const root = parse(html);

  for (const el of root.querySelectorAll(
    'script, style, nav, header, footer, .nav, .header, .footer, .sidebar',
  )) {
    el.remove();
  }

  const content =
    root.querySelector('.texto, .text-content, article, main, #content') ??
    root.querySelector('body');
  const text = normaliseWhitespace(content?.text ?? stripHtml(html));

  return {
    text,
    title: entry?.title ?? id,
    authors: entry?.authors ?? [],
    language: entry?.language ?? 'es',
  };
}

register('cervantes', {
  description:
    'Cervantes Virtual Library — Spanish and Portuguese literature. Search via the SPARQL linked-data catalog (data.cervantesvirtual.com); full text available for a small curated set of well-known works (Quijote, Lorca, Neruda, Borges, Rulfo, Calderón, San Juan de la Cruz).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://www.cervantesvirtual.com',
  verifiedAt: '2026-09-01',
  search: cervantesSearch,
  async read(id) {
    const raw = await cervantesRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
