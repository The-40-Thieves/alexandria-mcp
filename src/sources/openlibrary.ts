import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';

const OL_BASE = 'https://openlibrary.org';

interface OLSearchDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  language?: string[];
  subject?: string[];
  ia?: string[]; // Internet Archive identifiers
  public_scan_b?: boolean; // true = full text available
  ebook_access?: string;
}

interface OLSearchResponse {
  numFound: number;
  docs: OLSearchDoc[];
}

export async function openLibrarySearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const url =
    `${OL_BASE}/search.json?q=${encodeURIComponent(query)}` +
    `&limit=${limit}&fields=key,title,author_name,first_publish_year,language,subject,ia,public_scan_b,ebook_access`;

  const data = await fetchJSON<OLSearchResponse>(url);

  return data.docs.map((doc) => {
    const workId = doc.key.replace('/works/', '');
    const iaId = doc.ia?.[0];
    const hasFullText =
      doc.public_scan_b === true || doc.ebook_access === 'public' || Boolean(iaId);

    return {
      id: workId,
      source: 'openlibrary' as const,
      title: doc.title,
      authors: doc.author_name ?? [],
      year: doc.first_publish_year,
      language: doc.language?.[0],
      subjects: (doc.subject ?? []).slice(0, 5),
      hasFullText,
      previewUrl: `${OL_BASE}/works/${workId}`,
      downloadUrl: iaId ? `https://archive.org/download/${iaId}/${iaId}_djvu.txt` : undefined,
    };
  });
}

// OpenLibrary is primarily a discovery/metadata source.
// For full text, use the archive source with the IA identifier
// returned in downloadUrl above.
export async function openLibraryMeta(workId: string): Promise<{
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  subjects: string[];
  iaId?: string;
}> {
  interface OLWork {
    title: string;
    authors?: Array<{ author: { key: string } }>;
    first_publish_date?: string;
    subjects?: string[];
  }

  const work = await fetchJSON<OLWork>(`${OL_BASE}/works/${workId}.json`);

  // Resolve author names
  const authors: string[] = [];
  for (const ref of work.authors ?? []) {
    try {
      interface OLAuthor {
        name: string;
      }
      const author = await fetchJSON<OLAuthor>(`${OL_BASE}${ref.author.key}.json`);
      authors.push(author.name);
    } catch {
      // skip unresolvable author
    }
  }

  // Get an edition with IA link
  interface OLEditions {
    entries: Array<{ ia?: string[]; publish_date?: string; languages?: Array<{ key: string }> }>;
  }
  const editions = await fetchJSON<OLEditions>(`${OL_BASE}/works/${workId}/editions.json?limit=5`);

  const iaId = editions.entries.find((e) => e.ia?.length)?.ia?.[0];
  const language = editions.entries
    .find((e) => e.languages?.length)
    ?.languages?.[0]?.key.replace('/languages/', '');

  return {
    title: work.title,
    authors,
    year: work.first_publish_date ? parseInt(work.first_publish_date, 10) : undefined,
    language,
    subjects: (work.subjects ?? []).slice(0, 5),
    iaId,
  };
}

import { register } from './registry.js';

register('openlibrary', {
  description:
    'Open Library — 30M+ records. Metadata and discovery; links to Archive.org for text.',
  supportsIngest: false,
  search: openLibrarySearch,
  async read(id) {
    const meta = await openLibraryMeta(id);
    return {
      title: meta.title,
      authors: meta.authors,
      year: meta.year,
      language: meta.language,
      metadataOnly: true,
      externalUrl: meta.iaId ? `https://archive.org/details/${meta.iaId}` : undefined,
      note: meta.iaId
        ? `Full text available via Archive.org. Use library_read with source="archive" and id="${meta.iaId}".`
        : 'No full text found for this work.',
    };
  },
});
