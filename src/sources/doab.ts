import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const API = 'https://directory.doabooks.org/rest/search';

interface DOABItem {
  uuid?: string;
  name?: string;
  metadata?: Array<{ key: string; value: string; language?: string }>;
  link?: string;
}

function getMeta(metadata: DOABItem['metadata'], key: string): string[] {
  return (metadata ?? []).filter((m) => m.key === key).map((m) => m.value);
}

function firstMeta(metadata: DOABItem['metadata'], key: string): string | undefined {
  return getMeta(metadata, key)[0];
}

export async function doabSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    query,
    expand: 'metadata',
    limit: String(limit),
    offset: '0',
  });

  const data = await fetchJSON<DOABItem[]>(`${API}?${params}`, {
    headers: { Accept: 'application/json' },
  });

  return (data ?? []).slice(0, limit).map((item) => {
    const meta = item.metadata;
    const handle = firstMeta(meta, 'dc.identifier.uri') ?? item.link ?? item.uuid ?? '';
    const year = firstMeta(meta, 'dc.date.issued') ?? firstMeta(meta, 'dc.date.accessioned');

    return {
      id: handle,
      source: 'doab' as const,
      title: firstMeta(meta, 'dc.title') ?? item.name ?? handle,
      authors: getMeta(meta, 'dc.contributor.author'),
      year: year ? parseInt(year, 10) : undefined,
      language: firstMeta(meta, 'dc.language.iso'),
      subjects: getMeta(meta, 'dc.subject.classification').slice(0, 5),
      hasFullText: true,
      previewUrl: handle.startsWith('http') ? handle : `https://www.doabooks.org/handle/${handle}`,
    };
  });
}

register('doab', {
  description:
    'Directory of Open Access Books — 70k+ peer-reviewed OA academic monographs across all disciplines. Metadata + external PDF links.',
  supportsIngest: false,
  search: doabSearch,
  async read(id) {
    const previewUrl = id.startsWith('http') ? id : `https://www.doabooks.org/handle/${id}`;
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: previewUrl,
      note: 'DOAB links to publisher-hosted OA PDFs. Visit externalUrl to download the full text.',
    };
  },
});
