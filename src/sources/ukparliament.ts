// UK Parliament Bills API: legislation before the UK Parliament. No API key
// required.
import type { LibraryResult } from '../types.js';
import { defineRest } from './kinds/rest.js';
import { truncateText } from './registry.js';

const BASE = 'https://bills-api.parliament.uk/api/v1';

interface UkBill {
  billId: number;
  shortTitle: string;
  currentHouse?: string;
}

interface UkBillListResponse {
  items?: UkBill[];
}

interface UkBillDetail extends UkBill {
  longTitle?: string;
  summary?: string;
  isAct?: boolean;
  lastUpdate?: string;
}

export function normalizeUkParliament(bill: UkBill): LibraryResult {
  return {
    id: String(bill.billId),
    source: 'ukparliament',
    title: bill.shortTitle,
    authors: [],
    hasFullText: false,
    description: bill.currentHouse ? `Currently in the ${bill.currentHouse}` : undefined,
    url: `https://bills.parliament.uk/bills/${bill.billId}`,
  };
}

defineRest<UkBillListResponse>({
  name: 'ukparliament',
  description:
    'UK Parliament Bills API: public legislation before the House of Commons and House of Lords. No API key required.',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://bills.parliament.uk',
  supportsIngest: false,
  search: {
    url: (q, limit) =>
      `${BASE}/Bills?SearchTerm=${encodeURIComponent(q)}&Take=${limit}`,
    pick: (raw) => raw.items ?? [],
    normalize: normalizeUkParliament,
  },
  read: {
    url: (id) => `${BASE}/Bills/${encodeURIComponent(id)}`,
    normalize: (raw: UkBillDetail, id: string) => {
      const text = [
        raw.longTitle,
        raw.summary,
        raw.currentHouse ? `Currently in the ${raw.currentHouse}` : undefined,
        raw.isAct ? 'This bill has become an Act.' : undefined,
      ]
        .filter((l): l is string => Boolean(l))
        .join('\n\n');
      return {
        title: raw.shortTitle || id,
        authors: [],
        year: raw.lastUpdate ? new Date(raw.lastUpdate).getFullYear() : undefined,
        ...truncateText(text || `No details available for bill ${id}.`),
      };
    },
  },
});
