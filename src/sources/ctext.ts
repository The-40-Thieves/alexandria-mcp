import { fetchJSON } from '../utils/http.js';
import { normaliseWhitespace } from '../utils/text-clean.js';
import type { LibraryResult } from '../types.js';
import { register, truncateText } from './registry.js';

const API = 'https://ctext.org/api.pl';

interface CtextSearchResult {
  result: Array<{ id: string; title: string; type: string }>;
}

interface CtextTextNode {
  id: string;
  title: string;
  text?: string;
  books?: CtextTextNode[];
  chapters?: CtextTextNode[];
}

export async function ctextSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    if: 'searchtexts',
    q: query,
    args: limit.toString(),
  });

  const data = await fetchJSON<CtextSearchResult>(`${API}?${params}`);

  return (data.result ?? []).slice(0, limit).map(item => ({
    id: item.id,
    source: 'ctext' as const,
    title: item.title,
    authors: [],
    language: 'zh',
    subjects: ['Chinese classics', item.type].filter(Boolean),
    hasFullText: true,
    previewUrl: `https://ctext.org/${item.id}`,
  }));
}

export async function ctextRead(id: string): Promise<{
  text: string; title: string; authors: string[]; language?: string;
}> {
  // Fetch the text tree to get structure
  const data = await fetchJSON<CtextTextNode>(
    `${API}?if=gettextinfo&ci=${encodeURIComponent(id)}`
  );

  const title = data.title ?? id;
  const chapters = data.chapters ?? data.books ?? [];

  if (chapters.length === 0) {
    // Leaf node — fetch text directly
    const textData = await fetchJSON<{ text: string }>(
      `${API}?if=gettext&ci=${encodeURIComponent(id)}&ids=0`
    );
    return { text: normaliseWhitespace(textData.text ?? ''), title, authors: [], language: 'zh' };
  }

  const parts: string[] = [];
  for (const chapter of chapters.slice(0, 100)) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const chData = await fetchJSON<{ text: string }>(
        `${API}?if=gettext&ci=${encodeURIComponent(chapter.id)}&ids=0`
      );
      const text = (chData.text ?? '').trim();
      if (text.length > 20) parts.push(`\n\n# ${chapter.title}\n\n${text}`);
    } catch { /* skip */ }
  }

  return {
    text: normaliseWhitespace(parts.join('\n')),
    title,
    authors: [],
    language: 'zh',
  };
}

register('ctext', {
  description: 'Chinese Text Project — pre-Qin and Han dynasty classical Chinese texts with English translations.',
  supportsIngest: true,
  search: ctextSearch,
  async read(id) {
    const raw = await ctextRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
