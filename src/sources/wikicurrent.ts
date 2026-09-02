// Wikipedia Portal:Current events: the day-by-day current-events log,
// parsed from the portal's rendered HTML (there is no JSON API for this
// content). No API key required. The portal page embeds roughly the last
// week of day sections client-side transcluded, each a
// `div.current-events-main` with a `.bday` span carrying the ISO date and a
// `.current-events-content` div carrying that day's event list; this is
// cached module-scope for a short TTL rather than downloaded once per
// process (like kev.ts/attack.ts), since the content changes daily.
import { parse as parseHtml } from 'node-html-parser';
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const URL =
  'https://en.wikipedia.org/w/api.php?action=parse&page=Portal:Current_events&prop=text&format=json&formatversion=2';
const TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface WikicurrentSection {
  date: string;
  text: string;
}

interface ParseResponse {
  parse?: { text?: string };
}

let cache: { fetchedAt: number; sections: WikicurrentSection[] } | undefined;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function parseSections(html: string): WikicurrentSection[] {
  const root = parseHtml(html);
  const sections: WikicurrentSection[] = [];
  for (const el of root.querySelectorAll('.current-events-main')) {
    const date = el.querySelector('.bday')?.text?.trim();
    const content = el.querySelector('.current-events-content')?.text;
    if (!date || !content) continue;
    sections.push({ date, text: collapseWhitespace(content) });
  }
  return sections;
}

async function loadSections(): Promise<WikicurrentSection[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.sections;
  const data = await fetchJSON<ParseResponse>(URL, {}, TIMEOUT_MS);
  const sections = parseSections(data.parse?.text ?? '');
  cache = { fetchedAt: now, sections };
  return sections;
}

function matches(section: WikicurrentSection, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = section.text.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizeWikicurrent(section: WikicurrentSection): LibraryResult {
  return {
    id: section.date,
    source: 'wikicurrent',
    title: `Current events ${section.date}`,
    authors: [],
    year: Number(section.date.slice(0, 4)) || undefined,
    hasFullText: true,
    description: section.text.slice(0, 300),
    published: section.date,
  };
}

export async function wikicurrentSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const sections = await loadSections();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sections
    .filter((s) => matches(s, tokens))
    .slice(0, limit)
    .map(normalizeWikicurrent);
}

export async function wikicurrentRead(id: string): Promise<ReadResult> {
  const sections = await loadSections();
  const section = sections.find((s) => s.date === id);
  if (!section) {
    throw new Error(`wikicurrent: no current-events section found for ${id}`);
  }
  return {
    title: `Current events ${section.date}`,
    authors: [],
    ...truncateText(section.text),
  };
}

register('wikicurrent', {
  description:
    "Wikipedia Portal:Current events: the collaboratively edited daily log of world news, parsed from the portal's rendered HTML. No API key required.",
  supportsIngest: true,
  kind: 'rest',
  cluster: 'news_global',
  freshness: 'daily',
  homepage: 'https://en.wikipedia.org/wiki/Portal:Current_events',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: wikicurrentSearch,
  read: wikicurrentRead,
});
