// Regulations.gov API v4: US federal rulemaking dockets and public comment
// documents. Requires DATA_GOV_API_KEY. page[size] has a minimum of 5
// (confirmed live: a smaller value 400s "Page size parameter must be a
// positive number of 5 or greater"), so the url builder floors the
// requested limit at 5.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://api.regulations.gov/v4';

interface RegulationsAttributes {
  title?: string;
  postedDate?: string;
  documentType?: string;
  docketId?: string;
}

interface RegulationsDocument {
  id: string;
  attributes?: RegulationsAttributes;
}

interface RegulationsSearchResponse {
  data?: RegulationsDocument[];
}

interface RegulationsItemResponse {
  data?: RegulationsDocument;
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeRegulations(item: RegulationsDocument): LibraryResult {
  return {
    id: item.id,
    source: 'regulations',
    title: item.attributes?.title || item.id,
    authors: [],
    year: yearOf(item.attributes?.postedDate),
    hasFullText: false,
    published: item.attributes?.postedDate,
    url: `https://www.regulations.gov/document/${item.id}`,
  };
}

defineRest<RegulationsSearchResponse>({
  name: 'regulations',
  description:
    'Regulations.gov API v4: US federal rulemaking dockets and public comment documents. Requires DATA_GOV_API_KEY.',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://www.regulations.gov',
  supportsIngest: false,
  auth: { type: 'query', env: 'DATA_GOV_API_KEY', param: 'api_key' },
  search: {
    url: (q, limit) =>
      `${BASE}/documents?filter%5BsearchTerm%5D=${encodeURIComponent(q)}&page%5Bsize%5D=${Math.max(limit, 5)}`,
    pick: (raw) => raw.data ?? [],
    normalize: normalizeRegulations,
  },
  read: {
    url: (id) => `${BASE}/documents/${encodeURIComponent(id)}`,
    normalize: (raw: RegulationsItemResponse, id: string) => {
      const item = raw.data;
      if (!item) {
        return { title: id, authors: [], ...truncateText(`No document found for ${id}.`) };
      }
      const text = [
        item.attributes?.title,
        item.attributes?.documentType ? `Type: ${item.attributes.documentType}` : undefined,
        item.attributes?.docketId ? `Docket: ${item.attributes.docketId}` : undefined,
      ]
        .filter((l): l is string => Boolean(l))
        .join('\n');
      return {
        title: item.attributes?.title || id,
        authors: [],
        year: yearOf(item.attributes?.postedDate),
        ...truncateText(text || `No details available for ${id}.`),
      };
    },
  },
});
