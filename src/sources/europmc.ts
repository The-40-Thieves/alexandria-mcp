import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

interface EPMCResult {
  id: string;
  source: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title: string;
  authorString?: string;
  pubYear?: string;
  abstractText?: string;
  isOpenAccess?: string;
  keywordList?: { keyword: string[] };
}

interface EPMCResponse {
  resultList?: { result: EPMCResult[] };
}

function stripXml(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function europmcSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<EPMCResponse>(
    `${BASE}/search?query=${encodeURIComponent(query)}&format=json&pageSize=${limit}&resultType=core`,
  );
  return (data.resultList?.result || []).map((r) => ({
    id: r.pmid ? `MED:${r.pmid}` : `${r.source}:${r.id}`,
    source: 'europmc' as const,
    title: r.title,
    authors: r.authorString ? r.authorString.split(', ') : [],
    year: r.pubYear ? parseInt(r.pubYear, 10) : undefined,
    subjects: r.keywordList?.keyword || [],
    hasFullText: Boolean(r.pmcid) && r.isOpenAccess === 'Y',
    previewUrl: r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : undefined,
    description: r.abstractText?.substring(0, 300),
  }));
}

export async function europmcRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const [src, srcId] = id.split(':');

  // Try full-text XML (PMC open access only)
  try {
    const xml = await fetchText(`${BASE}/${src}/${srcId}/fullTextXML`);
    const text = stripXml(xml);
    if (text.length > 500) {
      const meta = await fetchJSON<EPMCResponse>(
        `${BASE}/search?query=ext_id:${srcId}&format=json&resultType=core`,
      );
      const r = meta.resultList?.result?.[0];
      return {
        text,
        title: r?.title || id,
        authors: r?.authorString ? r.authorString.split(', ') : [],
        year: r?.pubYear ? parseInt(r.pubYear, 10) : undefined,
        language: 'en',
      };
    }
  } catch {
    /* fall through to abstract */
  }

  const data = await fetchJSON<EPMCResponse>(
    `${BASE}/search?query=ext_id:${srcId}&format=json&resultType=core`,
  );
  const r = data.resultList?.result?.[0];
  if (!r) throw new Error(`Europe PMC record not found: ${id}`);
  return {
    text: r.abstractText || `No abstract available for ${id}`,
    title: r.title,
    authors: r.authorString ? r.authorString.split(', ') : [],
    year: r.pubYear ? parseInt(r.pubYear, 10) : undefined,
    language: 'en',
  };
}

register('europmc', {
  description:
    'Europe PMC — 43M+ biomedical and life science literature. Full text for open access PMC articles.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://europepmc.org',
  verifiedAt: '2026-09-01',
  search: europmcSearch,
  async read(id) {
    const raw = await europmcRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
