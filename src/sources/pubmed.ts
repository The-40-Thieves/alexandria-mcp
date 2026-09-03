// PubMed (NCBI E-utilities): MeSH-aware biomedical literature search.
// search() chains esearch (query -> PMIDs) then esummary (PMIDs ->
// metadata, incl. a PMCID when one exists). read() prefers PMC's BioC full
// text when a PMCID is present (idconv isn't needed - esummary's
// articleids already carries it), falling back to the PubMed abstract via
// efetch otherwise. Multiple sequential/branching fetches, so this is a
// hand-written register() rather than defineRest.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const BIOC_BASE = 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json';

// Raises the E-utilities keyless 3 rps limit to 10 rps; the source works
// without one.
function apiKeyParam(): string {
  const key = process.env.NCBI_API_KEY;
  return key ? `&api_key=${encodeURIComponent(key)}` : '';
}

interface EsearchResponse {
  esearchresult?: { idlist?: string[] };
}
interface EsummaryArticleId {
  idtype: string;
  value: string;
}
interface EsummaryDocSum {
  uid: string;
  title?: string;
  pubdate?: string;
  authors?: Array<{ name: string }>;
  fulljournalname?: string;
  articleids?: EsummaryArticleId[];
}
interface EsummaryResult {
  uids?: string[];
  [uid: string]: unknown;
}
interface EsummaryResponse {
  result?: EsummaryResult;
}

function docFor(result: EsummaryResult | undefined, uid: string): EsummaryDocSum | undefined {
  return result?.[uid] as EsummaryDocSum | undefined;
}

function pmcIdFor(doc: EsummaryDocSum): string | undefined {
  return doc.articleids?.find((a) => a.idtype === 'pmc')?.value;
}

function yearFrom(pubdate?: string): number | undefined {
  const match = pubdate?.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
}

export function normalizePubmedDoc(doc: EsummaryDocSum): LibraryResult {
  const pmcid = pmcIdFor(doc);
  return {
    id: doc.uid,
    source: 'pubmed',
    title: doc.title || 'Untitled',
    authors: (doc.authors ?? []).map((a) => a.name),
    year: yearFrom(doc.pubdate),
    subjects: doc.fulljournalname ? [doc.fulljournalname] : undefined,
    hasFullText: Boolean(pmcid),
    previewUrl: `https://pubmed.ncbi.nlm.nih.gov/${doc.uid}/`,
  };
}

export async function pubmedSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const esearch = await fetchJSON<EsearchResponse>(
    `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json${apiKeyParam()}`,
  );
  const ids = esearch.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const esummary = await fetchJSON<EsummaryResponse>(
    `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json${apiKeyParam()}`,
  );
  const uids = esummary.result?.uids ?? [];
  const results: LibraryResult[] = [];
  for (const uid of uids) {
    const doc = docFor(esummary.result, uid);
    if (doc) results.push(normalizePubmedDoc(doc));
  }
  return results;
}

interface BiocPassage {
  text?: string;
}
interface BiocDocument {
  passages?: BiocPassage[];
}
interface BiocCollection {
  documents?: BiocDocument[];
}

// PMC's BioC service wraps its collection in a top-level array
// ([BioCCollection]); parses either that or a bare object defensively.
export function parseBiocFullText(raw: string): string | undefined {
  const parsed = JSON.parse(raw) as BiocCollection[] | BiocCollection;
  const collection = Array.isArray(parsed) ? parsed[0] : parsed;
  const passages = collection?.documents?.[0]?.passages ?? [];
  const text = passages
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n\n');
  return text.length > 0 ? text : undefined;
}

async function fetchBiocFullText(pmcid: string): Promise<string | undefined> {
  try {
    const raw = await fetchText(`${BIOC_BASE}/${pmcid}/unicode`);
    return parseBiocFullText(raw);
  } catch {
    return undefined; // not in the OA subset, or the service is unavailable
  }
}

export async function pubmedRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
}> {
  const esummary = await fetchJSON<EsummaryResponse>(
    `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(id)}&retmode=json${apiKeyParam()}`,
  );
  const doc = docFor(esummary.result, id);
  if (!doc) throw new Error(`PubMed record not found: ${id}`);

  const pmcid = pmcIdFor(doc);
  const fullText = pmcid ? await fetchBiocFullText(pmcid) : undefined;
  const text =
    fullText ??
    (await fetchText(
      `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(id)}&rettype=abstract&retmode=text${apiKeyParam()}`,
    ));

  return {
    text: text || `No text available for PubMed ${id}.`,
    title: doc.title || `PubMed ${id}`,
    authors: (doc.authors ?? []).map((a) => a.name),
    year: yearFrom(doc.pubdate),
  };
}

register('pubmed', {
  description:
    'PubMed (NCBI E-utilities): MeSH-aware biomedical literature search. read() returns PMC BioC full text when a PMCID exists, otherwise the PubMed abstract via efetch. Works keyless (3 rps); set NCBI_API_KEY for 10 rps.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://pubmed.ncbi.nlm.nih.gov',
  verifiedAt: '2026-09-03',
  optionalEnv: ['NCBI_API_KEY'],
  pacing: { minIntervalMs: 334 },
  search: pubmedSearch,
  async read(id): Promise<ReadResult> {
    const raw = await pubmedRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
