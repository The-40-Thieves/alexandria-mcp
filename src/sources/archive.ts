import { fetchJSON, fetchText } from '../utils/http.js';
import { cleanArchiveText } from '../utils/text-clean.js';
import type { LibraryResult } from '../types.js';

const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_DOWNLOAD = 'https://archive.org/download';
const IA_METADATA = 'https://archive.org/metadata';

interface IASearchDoc {
  identifier: string;
  title?: string;
  creator?: string | string[];
  year?: string | number;
  language?: string | string[];
  subject?: string | string[];
}

interface IASearchResponse {
  response: {
    numFound: number;
    docs: IASearchDoc[];
  };
}

interface IAMetadata {
  metadata: {
    identifier: string;
    title?: string;
    creator?: string | string[];
    date?: string;
    language?: string | string[];
    subject?: string | string[];
  };
  files: Array<{
    name: string;
    format: string;
    size?: string;
  }>;
}

function normaliseArray(val?: string | string[]): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

export async function archiveSearch(
  query: string,
  limit = 10
): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: `${query} AND mediatype:texts`,
    'fl[]': 'identifier,title,creator,year,language,subject',
    rows: String(limit),
    output: 'json',
    'sort[]': 'downloads desc',
  });

  const data = await fetchJSON<IASearchResponse>(`${IA_SEARCH}?${params}`);

  return data.response.docs.map(doc => ({
    id: doc.identifier,
    source: 'archive' as const,
    title: doc.title ?? doc.identifier,
    authors: normaliseArray(doc.creator),
    year: doc.year ? parseInt(String(doc.year), 10) : undefined,
    language: normaliseArray(doc.language)[0],
    subjects: normaliseArray(doc.subject).slice(0, 5),
    hasFullText: true, // IA texts almost always have text
    previewUrl: `https://archive.org/details/${doc.identifier}`,
    downloadUrl: `${IA_DOWNLOAD}/${doc.identifier}/${doc.identifier}_djvu.txt`,
  }));
}

// Try multiple text formats in order of preference.
// IA item names are not always predictable, so we check the file list first.
const PREFERRED_FORMATS = [
  'DjVuTXT',
  'Plain Text',
  'Additional Text',
  'Abbyy GZ',  // last resort, needs unzipping — skipped for now
];

async function resolveTextUrl(identifier: string): Promise<string | null> {
  const meta = await fetchJSON<IAMetadata>(`${IA_METADATA}/${identifier}`);

  const textFile = PREFERRED_FORMATS
    .map(fmt => meta.files.find(f => f.format === fmt))
    .find(Boolean);

  if (textFile) {
    return `${IA_DOWNLOAD}/${identifier}/${textFile.name}`;
  }

  // Fallback: guess common naming patterns
  const candidates = [
    `${identifier}_djvu.txt`,
    `${identifier}.txt`,
    `${identifier}_text.txt`,
  ];

  for (const candidate of candidates) {
    const exists = meta.files.find(f => f.name === candidate);
    if (exists) return `${IA_DOWNLOAD}/${identifier}/${candidate}`;
  }

  return null;
}

export async function archiveRead(identifier: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
  year?: number;
}> {
  const meta = await fetchJSON<IAMetadata>(`${IA_METADATA}/${identifier}`);
  const m = meta.metadata;

  const textUrl = await resolveTextUrl(identifier);
  if (!textUrl) {
    throw new Error(
      `No plain-text version found for Archive.org item "${identifier}". ` +
      `Check https://archive.org/details/${identifier} for available formats.`
    );
  }

  // Polite rate limiting for IA
  await new Promise(r => setTimeout(r, 500));

  const raw = await fetchText(textUrl);
  const text = cleanArchiveText(raw);

  if (text.length < 500) {
    throw new Error(
      `Archive.org item "${identifier}" returned unexpectedly short text (${text.length} chars). ` +
      `The OCR may be missing or empty.`
    );
  }

  return {
    text,
    title: m.title ?? identifier,
    authors: normaliseArray(m.creator),
    language: normaliseArray(m.language)[0],
    year: m.date ? parseInt(m.date, 10) : undefined,
  };
}

import { register, truncateText } from './registry.js';
register('archive', {
  description: 'Internet Archive — 41M+ texts, scanned books, historical documents.',
  supportsIngest: true,
  search: archiveSearch,
  async read(id) {
    const raw = await archiveRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
