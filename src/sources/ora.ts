import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE_URL = 'https://ora.ox.ac.uk/api';

interface ORAPersonOrOrg {
  name?: string;
  family_name?: string;
  given_name?: string;
}

interface ORACreator {
  person_or_org?: ORAPersonOrOrg;
}

interface ORAFilesEntry {
  key: string;
  links?: { content?: string };
}

interface ORARecord {
  id: string;
  metadata?: {
    title?: string;
    creators?: ORACreator[];
    publication_date?: string;
    description?: string;
    subjects?: Array<{ subject: string }>;
    languages?: Array<{ id: string }>;
    resource_type?: { id?: string };
  };
  files?: {
    enabled?: boolean;
    entries?: Record<string, ORAFilesEntry>;
  };
}

interface ORAResponse {
  hits?: { total?: number; hits?: ORARecord[] };
}

function creatorName(c: ORACreator): string {
  const p = c.person_or_org;
  if (!p) return '';
  if (p.name) return p.name;
  return [p.given_name, p.family_name].filter(Boolean).join(' ');
}

function firstFileUrl(record: ORARecord): string | undefined {
  const entries = record.files?.entries;
  if (!entries) return undefined;
  return Object.values(entries)[0]?.links?.content;
}

export async function oraSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<ORAResponse>(
    `${BASE_URL}/records/?q=${encodeURIComponent(query)}&size=${limit}`,
  );
  return (data.hits?.hits || []).map((r) => {
    const meta = r.metadata || {};
    const year = meta.publication_date
      ? parseInt(meta.publication_date.substring(0, 4), 10)
      : undefined;
    return {
      id: r.id,
      source: 'ora' as const,
      title: meta.title || 'Untitled',
      authors: (meta.creators || []).map(creatorName).filter(Boolean),
      year: Number.isNaN(year as number) ? undefined : year,
      language: meta.languages?.[0]?.id,
      subjects: (meta.subjects || []).map((s) => s.subject),
      hasFullText: Boolean(meta.description || r.files?.enabled),
      previewUrl: firstFileUrl(r) || `https://ora.ox.ac.uk/objects/uuid:${r.id}`,
      description: meta.description?.substring(0, 300),
    };
  });
}

export async function oraRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const r = await fetchJSON<ORARecord>(`${BASE_URL}/records/${id}`);
  const meta = r.metadata || {};
  const year = meta.publication_date
    ? parseInt(meta.publication_date.substring(0, 4), 10)
    : undefined;
  return {
    text: meta.description || `No description available for Oxford ORA record ${id}`,
    title: meta.title || id,
    authors: (meta.creators || []).map(creatorName).filter(Boolean),
    year: Number.isNaN(year as number) ? undefined : year,
    language: meta.languages?.[0]?.id,
  };
}

register('ora', {
  description:
    'Oxford ORA — Oxford University Research Archive. Oxford theses, preprints, working papers, and the Oxford Text Archive (classical texts, TEI/XML). InvenioRDM API, no auth required.',
  supportsIngest: true,
  search: oraSearch,
  async read(id) {
    const raw = await oraRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
