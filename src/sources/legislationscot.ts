import { fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

// Scottish Parliament legislation: Acts of the Scottish Parliament (asp)
// and Scottish Statutory Instruments (ssi) from legislation.gov.uk
const BASE = 'https://www.legislation.gov.uk';
const TYPES = 'asp+ssi'; // ASP = Acts of Scottish Parliament, SSI = Scottish Statutory Instruments

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

function stripXml(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseId(uri: string): string {
  return uri.replace(/^https?:\/\/www\.legislation\.gov\.uk\//, '').replace(/\/$/, '');
}

export async function legislationscotSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const atom = await fetchText(
    `${BASE}/${TYPES}/data.feed?text=${encodeURIComponent(query)}&results-count=${limit}`
  );

  const entries = atom.split('<entry>').slice(1);
  return entries.map(entry => {
    const rawId = xmlField(entry, 'id');
    const id = parseId(rawId);
    const title = xmlField(entry, 'title');
    const updated = xmlField(entry, 'updated');
    const categories = xmlAll(entry, 'category');
    const year = updated ? parseInt(updated.substring(0, 4), 10) : undefined;
    const isASP = id.startsWith('asp');
    return {
      id,
      source: 'legislationscot' as const,
      title,
      authors: [],
      year,
      subjects: [...categories, isASP ? 'Acts of Scottish Parliament' : 'Scottish Statutory Instruments'],
      hasFullText: Boolean(id),
      previewUrl: rawId || `${BASE}/${id}`,
    };
  }).filter(r => r.id);
}

export async function legislationscotRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  const xml = await fetchText(`${BASE}/${id}/data.xml`);
  const text = stripXml(xml);

  if (text.length < 100) {
    throw new Error(`legislation.gov.uk returned no text for ${id}.`);
  }

  const title = xmlField(xml, 'dc:title') || xmlField(xml, 'Title') || id;
  const yearMatch = id.match(/(\d{4})/);

  return {
    text,
    title,
    authors: [],
    year: yearMatch ? parseInt(yearMatch[1], 10) : undefined,
    language: 'en',
  };
}

register('legislationscot', {
  description: 'Scottish Parliament legislation — Acts of the Scottish Parliament (ASP) and Scottish Statutory Instruments (SSI). No API key required.',
  supportsIngest: true,
  search: legislationscotSearch,
  async read(id) {
    const raw = await legislationscotRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
