// Task 7: library_citations. Given a seed item, returns the works it cites
// (`direction: 'references'`) or the works that cite it
// (`direction: 'citations'`), optionally rendered as a bibliography
// (`format: 'bibtex' | 'ris' | 'apa'`).
//
// Resolution (brief 04, step 1):
//   1. A DOI-shaped id, or the id/source's own adapter read() metadata
//      (Task 6's ReadResult.doi), resolves the seed to a DOI.
//   2. An arXiv id (or source: 'arxiv') resolves through OpenAlex by
//      constructing arXiv's own DOI (arXiv has minted one for every
//      submission as `10.48550/arXiv.<id>` since 2022) and looking that
//      up the normal way. The brief describes this step as an OpenAlex
//      `works/arxiv:` shorthand; verified live against the real API
//      (2026-09-03) that shorthand 404s - OpenAlex's only documented
//      external-id URN prefixes for /works are doi:/mag:/pmid:/pmcid:, and
//      arxiv: is not among them - so this goes through the DOI form
//      instead, which is what OpenAlex actually indexes arXiv works by.
//   3. Whichever of those succeeds gives a full OpenAlex work object.
//      `referenced_works` (an array of OpenAlex ids on the work itself)
//      drives `direction: 'references'`. `direction: 'citations'` was
//      meant to follow the work's own `cited_by_api_url` per the brief and
//      OpenAlex's docs, but a live work object no longer carries that
//      field at all (verified 2026-09-03: fetching a known work returns no
//      `cited_by_api_url` key); `works?filter=cites:<id>` is the
//      documented, currently-live equivalent (still-current filter-works
//      docs, and reproduced against the real API), so citations goes
//      through that filter directly instead.
//   4. When OpenAlex has no record for the resolved DOI at all (the work
//      fetch itself fails - not merely an empty reference list), Task 5's
//      OpenCitations adapter is the fallback: opencitationsSearch() for
//      citations, opencitationsRead() for references (its rendered
//      "N. doi:..." lines are parsed back into LibraryResult stubs).
import { fetchCrossrefBibtex } from '../sources/crossref.ts';
import { authParam, normalizeOpenAlex } from '../sources/openalex.ts';
import { opencitationsRead, opencitationsSearch } from '../sources/opencitations.ts';
import { getAdapter } from '../sources/registry.ts';
import type { LibraryResult } from '../types.ts';
import { type BibliographyStyle, formatBibliography } from '../utils/bibliography.ts';
import { fetchJSON } from '../utils/http.ts';

const OPENALEX_BASE = 'https://api.openalex.org';
// OpenAlex's `openalex_id:` filter accepts at most 50 `|`-separated ids
// per call (see OpenAlex's batch-id-lookup docs).
const OPENALEX_BATCH_SIZE = 50;
const DEFAULT_LIMIT = 20;

export type CitationDirection = 'references' | 'citations';

export interface LibraryCitationsOptions {
  id: string;
  source: string;
  direction: CitationDirection;
  limit?: number;
  format?: BibliographyStyle;
}

export interface LibraryCitationsSeed {
  id: string;
  source: string;
  doi?: string;
}

export interface LibraryCitationsResult {
  seed: LibraryCitationsSeed;
  direction: CitationDirection;
  results: LibraryResult[];
  formatted?: string;
}

// The subset of an OpenAlex work object this tool needs. Deliberately its
// own minimal interface rather than importing openalex.ts's internal
// OAWork (unexported, and missing these two citation-graph fields): every
// field here is optional except `id`, so this stays structurally
// assignable wherever normalizeOpenAlex's own (also-unexported) parameter
// type is expected.
interface OpenAlexWork {
  id: string;
  doi?: string;
  referenced_works?: string[];
}

type OpenAlexWorksResponse = Parameters<typeof normalizeOpenAlex>[0];

const DOI_RE = /^10\.\d{4,9}\/\S+$/i;
const DOI_URL_RE = /^https?:\/\/doi\.org\//i;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
// arXiv has minted a DOI of this exact form for every submission since
// 2022 (verified live against export.arxiv.org and OpenAlex 2026-09-03);
// OpenAlex indexes arXiv works by it, so an arXiv id resolves through this
// rather than through an id-shaped OpenAlex shorthand (see the module
// comment above).
function arxivDoi(id: string): string {
  return `10.48550/arXiv.${id.replace(/v\d+$/, '')}`;
}

function isDoi(id: string): boolean {
  return DOI_RE.test(id);
}

function isArxivId(id: string): boolean {
  return ARXIV_ID_RE.test(id);
}

function stripDoiUrl(doi: string): string {
  return doi.replace(DOI_URL_RE, '');
}

function bareOpenAlexId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//, '');
}

async function fetchOpenAlexWork(key: string): Promise<OpenAlexWork | undefined> {
  try {
    return await fetchJSON<OpenAlexWork>(`${OPENALEX_BASE}/works/${key}?${authParam()}`);
  } catch {
    return undefined;
  }
}

interface SeedResolution {
  work?: OpenAlexWork;
  doi?: string;
}

async function resolveSeed(id: string, source: string): Promise<SeedResolution> {
  if (isDoi(id)) {
    const work = await fetchOpenAlexWork(`doi:${id}`);
    return { work, doi: id };
  }
  if (source === 'openalex') {
    const work = await fetchOpenAlexWork(bareOpenAlexId(id));
    return { work, doi: work?.doi ? stripDoiUrl(work.doi) : undefined };
  }
  if (source === 'arxiv' || isArxivId(id)) {
    const doi = arxivDoi(id);
    const work = await fetchOpenAlexWork(`doi:${doi}`);
    return work ? { work, doi: work.doi ? stripDoiUrl(work.doi) : doi } : {};
  }
  // Task 6: every scholarly adapter's read() may populate ReadResult.doi.
  try {
    const read = await getAdapter(source).read(id);
    if (!read.doi) return {};
    const work = await fetchOpenAlexWork(`doi:${read.doi}`);
    return { work, doi: read.doi };
  } catch {
    return {};
  }
}

async function fetchReferences(work: OpenAlexWork, limit: number): Promise<LibraryResult[]> {
  const ids = (work.referenced_works ?? []).slice(0, limit).map(bareOpenAlexId);
  const results: LibraryResult[] = [];
  for (let i = 0; i < ids.length; i += OPENALEX_BATCH_SIZE) {
    const chunk = ids.slice(i, i + OPENALEX_BATCH_SIZE);
    const data = await fetchJSON<OpenAlexWorksResponse>(
      `${OPENALEX_BASE}/works?filter=openalex_id:${chunk.join('|')}&per_page=${chunk.length}&${authParam()}`,
    );
    results.push(...normalizeOpenAlex(data));
  }
  return results;
}

async function fetchCitingWorks(work: OpenAlexWork, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<OpenAlexWorksResponse>(
    `${OPENALEX_BASE}/works?filter=cites:${bareOpenAlexId(work.id)}&per_page=${limit}&${authParam()}`,
  );
  return normalizeOpenAlex(data);
}

// opencitationsRead() renders its reference list as text lines, one per
// reference: "N. doi:<doi>" when a DOI was extractable, "N. <raw pid
// list>" otherwise (see opencitations.ts's opencitationsRead). Parsed back
// into LibraryResult stubs, mirroring the shape normalizeOcCitingWork
// already gives the citing side.
const OC_REFERENCE_LINE_RE = /^\d+\.\s+(?:doi:(\S+)|(.+))$/;

function parseOcReferences(text: string, limit: number): LibraryResult[] {
  const results: LibraryResult[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(OC_REFERENCE_LINE_RE);
    if (!match) continue;
    const [, doi, raw] = match;
    results.push({
      id: doi ?? raw ?? line,
      source: 'opencitations',
      title: doi ? `Reference (doi:${doi})` : (raw ?? line),
      authors: [],
      hasFullText: false,
      previewUrl: doi ? `https://doi.org/${doi}` : undefined,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function extractItemDoi(item: LibraryResult): string | undefined {
  if (isDoi(item.id)) return item.id;
  if (item.previewUrl && DOI_URL_RE.test(item.previewUrl)) {
    return stripDoiUrl(item.previewUrl);
  }
  return undefined;
}

// BibTeX only: prefer Crossref's own content-negotiated BibTeX for any
// item whose DOI is resolvable, falling back to the local formatter for
// that one item when no DOI is known or the fetch fails. Sequential, not
// parallel - these are best-effort doi.org lookups made directly (not
// through the registered 'crossref' adapter's own pacing), so a tight loop
// of unpaced parallel calls is avoided by simply doing them one at a time.
async function buildFormatted(results: LibraryResult[], style: BibliographyStyle): Promise<string> {
  if (style !== 'bibtex') return formatBibliography(results, style);
  const entries: string[] = [];
  for (const item of results) {
    const doi = extractItemDoi(item);
    const preferred = doi ? await fetchCrossrefBibtex(doi) : '';
    entries.push(preferred || formatBibliography([item], 'bibtex'));
  }
  return entries.join('\n\n');
}

export async function libraryCitations(
  options: LibraryCitationsOptions,
): Promise<LibraryCitationsResult> {
  const { id, source, direction, limit = DEFAULT_LIMIT, format } = options;
  const { work, doi } = await resolveSeed(id, source);

  let results: LibraryResult[];
  if (work) {
    results =
      direction === 'references'
        ? await fetchReferences(work, limit)
        : await fetchCitingWorks(work, limit);
  } else if (doi) {
    // OpenAlex has no record for this DOI at all - fall back to OpenCitations.
    results =
      direction === 'references'
        ? parseOcReferences((await opencitationsRead(doi)).text ?? '', limit)
        : await opencitationsSearch(doi, limit);
  } else {
    results = [];
  }

  const seed: LibraryCitationsSeed = doi ? { id, source, doi } : { id, source };
  const result: LibraryCitationsResult = { seed, direction, results };
  if (format) result.formatted = await buildFormatted(results, format);
  return result;
}
