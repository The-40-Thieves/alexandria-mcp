import { fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult } from '../types.js';

const BASE = 'https://www.legislation.gov.uk';

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

function parseIdFromUri(uri: string): string {
  // https://www.legislation.gov.uk/ukpga/2023/1 -> ukpga/2023/1
  return uri.replace(/^https?:\/\/www\.legislation\.gov\.uk\//, '').replace(/\/$/, '');
}

export async function legislationSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const atom = await fetchText(
    `${BASE}/search?q=${encodeURIComponent(query)}&results-count=${limit}`
  );

  const entries = atom.split('<entry>').slice(1);
  return entries.map(entry => {
    const rawId = xmlField(entry, 'id');
    const id = parseIdFromUri(rawId);
    const title = xmlField(entry, 'title');
    const updated = xmlField(entry, 'updated');
    const categories = xmlAll(entry, 'category');
    const year = updated ? parseInt(updated.substring(0, 4), 10) : undefined;

    return {
      id,
      source: 'legislation' as const,
      title,
      authors: [],
      year,
      subjects: categories,
      hasFullText: Boolean(id),
      previewUrl: rawId || `${BASE}/${id}`,
    };
  }).filter(r => r.id);
}

export async function legislationRead(id: string): Promise<{
  text: string; title: string; authors: string[];
  year?: number; language?: string;
}> {
  // Fetch XML version — content negotiation via /data.xml
  const xml = await fetchText(`${BASE}/${id}/data.xml`);
  const text = stripXml(xml);

  if (text.length < 100) {
    throw new Error(`legislation.gov.uk returned no text for ${id}. The item may not have a current XML version.`);
  }

  // Extract title from XML
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

register('legislation', {
  description: 'legislation.gov.uk — UK Acts of Parliament, Statutory Instruments, and devolved legislation with time-aware full text. No API key required.',
  supportsIngest: true,
  search: legislationSearch,
  async read(id) {
    const raw = await legislationRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
