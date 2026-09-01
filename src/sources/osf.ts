import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.osf.io/v2';

interface OSFAttributes {
  title?: string;
  description?: string;
  date_created?: string;
  date_published?: string;
  tags?: string[];
  subjects?: Array<Array<{ text: string }>>;
  doi?: string;
  is_published?: boolean;
}

interface OSFPreprint {
  id: string;
  attributes?: OSFAttributes;
  relationships?: {
    provider?: { data?: { id?: string } };
  };
}

interface OSFResponse {
  data?: OSFPreprint[];
  links?: { next?: string | null };
}

function flatSubjects(subjects?: Array<Array<{ text: string }>>): string[] {
  if (!subjects) return [];
  return subjects.flatMap((arr) => arr.map((s) => s.text)).filter(Boolean);
}

export async function osfSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<OSFResponse>(
    `${BASE}/preprints/?filter[title]=${encodeURIComponent(query)}&filter[is_published]=true&page[size]=${limit}`,
  );

  return (data.data || []).map((p) => {
    const a = p.attributes || {};
    const date = a.date_published || a.date_created || '';
    const provider = p.relationships?.provider?.data?.id || '';
    return {
      id: p.id,
      source: 'osf' as const,
      title: a.title || 'Untitled',
      authors: [],
      year: date ? parseInt(date.substring(0, 4), 10) : undefined,
      subjects: [...flatSubjects(a.subjects), ...(a.tags || []).slice(0, 3)],
      hasFullText: Boolean(a.description),
      previewUrl: a.doi
        ? `https://doi.org/${a.doi}`
        : `https://osf.io/preprints/${provider}/${p.id}`,
      description: a.description?.substring(0, 300),
    };
  });
}

export async function osfRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<{ data?: OSFPreprint }>(`${BASE}/preprints/${id}/`);
  const a = data.data?.attributes || {};
  const date = a.date_published || a.date_created || '';

  return {
    text: a.description || `No abstract available for OSF preprint ${id}`,
    title: a.title || id,
    authors: [],
    year: date ? parseInt(date.substring(0, 4), 10) : undefined,
    language: 'en',
  };
}

register('osf', {
  description:
    'OSF Preprints — PsyArXiv, SocArXiv, EarthArXiv, engrXiv, and more via Open Science Framework. No API key required.',
  supportsIngest: true,
  search: osfSearch,
  async read(id) {
    const raw = await osfRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
