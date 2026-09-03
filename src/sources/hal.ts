// HAL (Hyper Articles en Ligne, api.archives-ouvertes.fr): 4M+ full-text
// French/EU academic deposits, Solr search. No API key required; no
// documented rate limit. Both search and read are a single JSON fetch with
// synchronous normalization, so this fits defineRest.
//
// A bare `q=<terms>` (no field prefix) already searches HAL's default
// field, which is the same full-text index `text_fulltext:<terms>` would
// hit explicitly (verified live 2026-09-03: both return the same top hits
// for a multi-word query) - so search() uses the simpler bare form.
// read() looks a single record up by its `halId_s` and returns the
// abstract as text; `fileMain_s` (when present) is the PDF link, which
// this task exposes as `downloadUrl` but does not fetch - fetchAsText only
// extracts HTML, not PDF (see secedgar.ts's read() for the same PDF
// caveat), and full PDF extraction is Task 6's tier.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://api.archives-ouvertes.fr/search/';
const FIELDS =
  'halId_s,title_s,authFullName_s,producedDate_s,uri_s,abstract_s,fileMain_s,docType_s';

interface HalDoc {
  halId_s: string;
  title_s?: string[];
  authFullName_s?: string[];
  producedDate_s?: string;
  uri_s?: string;
  abstract_s?: string[];
  fileMain_s?: string;
  docType_s?: string;
}
interface HalResponse {
  response?: { docs?: HalDoc[] };
}

function yearFrom(producedDate?: string): number | undefined {
  const year = producedDate ? Number(producedDate.slice(0, 4)) : Number.NaN;
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeHal(doc: HalDoc): LibraryResult {
  return {
    id: doc.halId_s,
    source: 'hal',
    title: doc.title_s?.[0] || 'Untitled',
    authors: doc.authFullName_s ?? [],
    year: yearFrom(doc.producedDate_s),
    subjects: doc.docType_s ? [doc.docType_s] : undefined,
    hasFullText: Boolean(doc.fileMain_s),
    previewUrl: doc.uri_s,
    downloadUrl: doc.fileMain_s,
    description: doc.abstract_s?.[0]?.slice(0, 300),
  };
}

defineRest<HalResponse>({
  name: 'hal',
  description:
    'HAL (Hyper Articles en Ligne): 4M+ full-text French/EU academic deposits with a Solr search across titles, abstracts, and full text. No API key required.',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://hal.science',
  supportsIngest: true,
  verifiedAt: '2026-09-03',
  search: {
    url: (q, limit) => `${BASE}?q=${encodeURIComponent(q)}&rows=${limit}&wt=json&fl=${FIELDS}`,
    pick: (raw) => raw.response?.docs ?? [],
    normalize: normalizeHal,
  },
  read: {
    url: (id) => `${BASE}?q=halId_s:${encodeURIComponent(id)}&wt=json&fl=${FIELDS}`,
    normalize: (raw: HalResponse, id: string) => {
      const doc = raw.response?.docs?.[0];
      if (!doc) throw new Error(`HAL record not found: ${id}`);
      const abstract = doc.abstract_s?.join('\n\n');
      const text =
        abstract ||
        `No abstract available for HAL record ${id}.` +
          (doc.fileMain_s ? ` Full text PDF: ${doc.fileMain_s}` : '');
      return {
        title: doc.title_s?.[0] || id,
        authors: doc.authFullName_s ?? [],
        year: yearFrom(doc.producedDate_s),
        externalUrl: doc.uri_s,
        ...truncateText(text),
      };
    },
  },
});
