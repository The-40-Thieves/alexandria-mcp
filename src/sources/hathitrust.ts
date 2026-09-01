import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const HT = 'https://catalog.hathitrust.org/api/v2';

interface HTVolume {
  htid: string;
  title?: string;
  author?: string;
  publishDate?: string;
  language?: string;
  rightsCode?: string;
}

interface HTSearchResponse {
  numFound: number;
  start: number;
  docs: HTVolume[];
}

export async function hathitrustSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    rows: String(limit),
    fl: 'htid,title,author,publishDate,language,rightsCode',
  });

  const data = await fetchJSON<HTSearchResponse>(`${HT}/volumes/search?${params}`);

  return (data.docs ?? []).slice(0, limit).map((v) => ({
    id: v.htid,
    source: 'hathitrust' as const,
    title: v.title ?? v.htid,
    authors: v.author ? [v.author] : [],
    year: v.publishDate ? parseInt(v.publishDate, 10) : undefined,
    language: v.language,
    hasFullText: v.rightsCode === 'pd' || v.rightsCode === 'pdus',
    previewUrl: `https://hdl.handle.net/2027/${v.htid}`,
  }));
}

register('hathitrust', {
  description:
    'HathiTrust — 18M+ volumes digitized from research libraries. Public domain texts available for download.',
  supportsIngest: false,
  search: hathitrustSearch,
  async read(id) {
    // Public domain full text via the HathiTrust data API requires institutional access.
    // Direct page images are available without auth but text extraction is complex.
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: `https://hdl.handle.net/2027/${id}`,
      note:
        'HathiTrust full-text download requires the HathiTrust Data API (htrc.hathitrust.org) for programmatic access. ' +
        'Public domain texts are readable at externalUrl. ' +
        'Use source="archive" to find the same text via Internet Archive.',
    };
  },
});
