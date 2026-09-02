import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.reporter.nih.gov/v2';

interface NIHPI {
  full_name?: string;
  first_name?: string;
  last_name?: string;
}

interface NIHProject {
  project_num?: string;
  project_title?: string;
  abstract_text?: string;
  fiscal_year?: number;
  principal_investigators?: NIHPI[];
  terms?: string;
}

interface NIHResponse {
  meta?: { total?: number; offset?: number; limit?: number };
  results?: NIHProject[];
}

function piName(pi: NIHPI): string {
  return pi.full_name || `${pi.first_name || ''} ${pi.last_name || ''}`.trim();
}

export async function nihSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<NIHResponse>(`${BASE}/projects/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      criteria: {
        advanced_text_search: {
          operator: 'and',
          search_field: 'projecttitle,terms',
          search_text: query,
        },
      },
      include_fields: [
        'ProjectTitle',
        'AbstractText',
        'FiscalYear',
        'PrincipalInvestigators',
        'ProjectNum',
      ],
      offset: 0,
      limit,
    }),
  });

  return (data.results || []).map((p) => ({
    id: p.project_num || '',
    source: 'nih' as const,
    title: p.project_title || 'Untitled',
    authors: (p.principal_investigators || []).map(piName).filter(Boolean),
    year: p.fiscal_year,
    subjects: [],
    hasFullText: Boolean(p.abstract_text),
    previewUrl: p.project_num
      ? `https://reporter.nih.gov/search/${encodeURIComponent(p.project_num)}`
      : undefined,
    description: p.abstract_text?.substring(0, 300),
  }));
}

export async function nihRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const data = await fetchJSON<NIHResponse>(`${BASE}/projects/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      criteria: { project_nums: [id] },
      include_fields: [
        'ProjectTitle',
        'AbstractText',
        'FiscalYear',
        'PrincipalInvestigators',
        'ProjectNum',
      ],
    }),
  });

  const p = data.results?.[0];
  if (!p) throw new Error(`NIH RePORTER project not found: ${id}`);

  return {
    text: p.abstract_text || `No abstract available for NIH project ${id}`,
    title: p.project_title || id,
    authors: (p.principal_investigators || []).map(piName).filter(Boolean),
    year: p.fiscal_year,
    language: 'en',
  };
}

register('nih', {
  description:
    'NIH RePORTER — National Institutes of Health funded research projects and abstracts. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'science',
  freshness: 'daily',
  homepage: 'https://reporter.nih.gov',
  verifiedAt: '2026-09-01',
  search: nihSearch,
  async read(id) {
    const raw = await nihRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
