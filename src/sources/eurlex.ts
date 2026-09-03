// EUR-Lex via the CELLAR SPARQL endpoint: EU law (treaties, regulations,
// directives, national implementing measures) keyed by CELEX id. No API
// key required. search() runs a keyword SPARQL query over
// `cdm:work_title`; read() fetches the stable EUR-Lex document URL
// (built from the CELEX id) through fetchAsText (SSRF-guarded), so this is
// a hand-written register() rather than defineRest (whose read() always
// expects a JSON response).
//
// EUR-Lex's reuse notice authorises reuse of its content provided the
// source is acknowledged (https://eur-lex.europa.eu/content/help/faq/reuse-instructions.html),
// so this source is ingestPolicy: 'attribution', the same reasoning as
// wikipedia.ts's CC BY-SA stamp.
//
// The CELLAR SPARQL endpoint has no documented per-query result cap, but
// EUR-Lex's own search UI has capped total results at 10,000 since
// 2026-01-01 - irrelevant to this adapter's small per-call `limit`, but
// worth naming since a caller paging deep into `hits` here would
// eventually run into that same wall upstream.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

const SPARQL_URL = 'https://publications.europa.eu/webapi/rdf/sparql';

interface SparqlBinding {
  work?: { value?: string };
  title?: { value?: string; 'xml:lang'?: string };
  celex?: { value?: string };
}
interface SparqlResponse {
  results?: { bindings?: SparqlBinding[] };
}

// Escapes the two characters that would otherwise break out of the SPARQL
// string literal this query embeds the caller's query into (a double quote
// closes the literal early; a backslash starts an escape sequence).
function escapeSparqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSearchQuery(q: string, limit: number): string {
  const term = escapeSparqlLiteral(q.toLowerCase());
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?work ?title ?celex WHERE {
  ?work cdm:work_title ?title .
  ?work cdm:resource_legal_id_celex ?celex .
  FILTER(CONTAINS(LCASE(STR(?title)), "${term}"))
} LIMIT ${limit}`;
}

function docUrl(celex: string): string {
  return `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${encodeURIComponent(celex)}`;
}

export function normalizeEurlexBinding(binding: SparqlBinding): LibraryResult | null {
  const celex = binding.celex?.value;
  const title = binding.title?.value;
  if (!celex || !title) return null;
  return {
    id: celex,
    source: 'eurlex',
    title,
    authors: [],
    hasFullText: true,
    previewUrl: docUrl(celex),
    language: binding.title?.['xml:lang'],
  };
}

export async function eurlexSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<SparqlResponse>(
    `${SPARQL_URL}?query=${encodeURIComponent(buildSearchQuery(query, limit))}`,
    { headers: { Accept: 'application/sparql-results+json' } },
  );
  const bindings = data.results?.bindings ?? [];
  const results: LibraryResult[] = [];
  for (const binding of bindings) {
    const r = normalizeEurlexBinding(binding);
    if (r) results.push(r);
  }
  return results;
}

// The document at a CELEX's stable URL is arbitrary EUR-Lex HTML;
// fetchAsText can fail on it (unavailable translation, a PDF-only annex)
// for reasons unrelated to a bug here, so a failure degrades to
// metadata-only, the same convention as secedgar.ts/mdn.ts.
export async function eurlexRead(celex: string): Promise<ReadResult> {
  const url = docUrl(celex);
  try {
    const page = await fetchAsText(url);
    return {
      title: page.title || celex,
      authors: [],
      externalUrl: url,
      ...truncateText(page.text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      title: celex,
      authors: [],
      metadataOnly: true,
      externalUrl: url,
      note: `Full-text fetch failed; showing metadata only: ${message}`,
    };
  }
}

register('eurlex', {
  description:
    'EUR-Lex (via the CELLAR SPARQL endpoint): EU treaties, regulations, directives, and national implementing measures, searchable by title keyword. No API key required.',
  supportsIngest: true,
  ingestPolicy: 'attribution',
  kind: 'rest',
  cluster: 'law',
  freshness: 'daily',
  homepage: 'https://eur-lex.europa.eu',
  verifiedAt: '2026-09-03',
  search: eurlexSearch,
  read: eurlexRead,
});
