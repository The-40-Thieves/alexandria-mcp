import { fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const API = 'https://export.arxiv.org/api/query';
const HTML = 'https://arxiv.org/html';

function xmlField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].replace(/<[^>]+>/g, '').trim());
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseId(raw: string): string {
  return raw.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
}

export async function arxivSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const xml = await fetchText(
    `${API}?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&sortBy=relevance`
  );
  return xml.split('<entry>').slice(1).map(entry => {
    const id = parseId(xmlField(entry, 'id'));
    const title = xmlField(entry, 'title');
    const summary = xmlField(entry, 'summary');
    const published = xmlField(entry, 'published');
    const authors = xmlAll(entry, 'name');
    const cat = entry.match(/arxiv:primary_category[^/]*term="([^"]+)"/)?.[1];
    return {
      id,
      source: 'arxiv' as const,
      title,
      authors,
      year: published ? parseInt(published.substring(0, 4), 10) : undefined,
      subjects: cat ? [cat] : [],
      hasFullText: true,
      previewUrl: `https://arxiv.org/abs/${id}`,
      description: summary.substring(0, 300),
    };
  });
}

export async function arxivRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  // Try HTML version first (most papers 2018+)
  try {
    const html = await fetchText(`${HTML}/${id}`);
    const text = stripHtml(html);
    if (text.length > 500) {
      const meta = await fetchText(`${API}?id_list=${id}`);
      return {
        text,
        title: xmlField(meta, 'title') || id,
        authors: xmlAll(meta, 'name'),
        year: xmlField(meta, 'published') ? parseInt(xmlField(meta, 'published').substring(0, 4), 10) : undefined,
        language: 'en',
      };
    }
  } catch { /* fall through */ }

  // Fall back to abstract
  const xml = await fetchText(`${API}?id_list=${id}`);
  return {
    text: xmlField(xml, 'summary') || `No text available for arxiv:${id}`,
    title: xmlField(xml, 'title') || id,
    authors: xmlAll(xml, 'name'),
    year: xmlField(xml, 'published') ? parseInt(xmlField(xml, 'published').substring(0, 4), 10) : undefined,
    language: 'en',
  };
}

register('arxiv', {
  description: 'arXiv — 2M+ open access preprints: physics, math, CS, biology, economics, statistics. Full HTML text for most papers (2018+).',
  supportsIngest: true,
  search: arxivSearch,
  async read(id) {
    const raw = await arxivRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
