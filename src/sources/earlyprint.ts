import type { LibraryResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BL = 'https://eplab.artsci.wustl.edu/blacklab-server/earlyprint';

function stripXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface BLDocInfo {
  title?: string[];
  author?: string[];
  yearFrom?: string[];
  lang?: string[];
  wordcount?: string[];
}

interface BLDocsResponse {
  docs?: Array<{ docPid: string; numberOfHits?: number }>;
  docInfos?: Record<string, BLDocInfo>;
  summary?: { numberOfDocsRetrieved?: number };
}

export async function earlyprintSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  // BlackLab document search with Lucene filter
  const filter = `title:${query} OR author:${query}`;
  const data = await fetchJSON<BLDocsResponse>(
    `${BL}/docs?filter=${encodeURIComponent(filter)}&number=${limit}&outputformat=json`,
  );

  const infos = data.docInfos || {};
  return (data.docs || []).map((doc) => {
    const info = infos[doc.docPid] || {};
    return {
      id: doc.docPid,
      source: 'earlyprint' as const,
      title: info.title?.[0] || doc.docPid,
      authors: info.author || [],
      year: info.yearFrom?.[0] ? parseInt(info.yearFrom[0], 10) : undefined,
      subjects: [],
      language: info.lang?.[0] || 'en',
      hasFullText: true,
      previewUrl: `https://texts.earlyprint.org/exist/apps/shc/view.html?tcp=${doc.docPid}`,
    };
  });
}

export async function earlyprintRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  // Fetch document metadata
  const metaData = await fetchJSON<BLDocsResponse>(
    `${BL}/docs?filter=pid:${id}&number=1&outputformat=json`,
  ).catch(() => ({}) as BLDocsResponse);

  const info: BLDocInfo = metaData.docInfos?.[id] || {};

  // Fetch document content
  const raw = await fetchText(`${BL}/docs/${id}/content?outputformat=json`);

  // Content may be JSON-wrapped or raw XML
  let xmlContent = raw;
  try {
    const parsed = JSON.parse(raw) as { content?: string };
    if (parsed.content) xmlContent = parsed.content;
  } catch {
    /* raw XML */
  }

  const text = stripXml(xmlContent);
  if (text.length < 100) {
    throw new Error(`EarlyPrint document ${id} returned no readable text.`);
  }

  return {
    text,
    title: info.title?.[0] || id,
    authors: info.author || [],
    year: info.yearFrom?.[0] ? parseInt(info.yearFrom[0], 10) : undefined,
    language: 'en',
  };
}

register('earlyprint', {
  description:
    'EarlyPrint — 60,000+ Early Modern English texts (EEBO/ECCO/Evans TCP), 1473–1700. Linguistically annotated. BlackLab-indexed. Hidden: the eplab.artsci.wustl.edu BlackLab catalog is returning 404 as of 2026-09; re-enable once it returns.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://earlyprint.org',
  verifiedAt: '2026-09-01',
  hidden: true,
  search: earlyprintSearch,
  async read(id) {
    const raw = await earlyprintRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
