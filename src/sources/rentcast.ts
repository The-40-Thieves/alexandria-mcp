// RentCast: US rental and sale market statistics by ZIP code. Requires
// RENTCAST_API_KEY (header X-Api-Key); the free tier is 50 requests/month,
// so pacing caps this source to one call per day.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const BASE = 'https://api.rentcast.io/v1';

interface RentcastRentalStats {
  averageRent?: number;
  medianRent?: number;
  minRent?: number;
  maxRent?: number;
  totalListings?: number;
}

interface RentcastMarket {
  zipCode: string;
  rentalData?: RentcastRentalStats;
}

export function normalizeRentcast(item: RentcastMarket): LibraryResult | null {
  if (!item.zipCode) return null;
  const rental = item.rentalData;
  return {
    id: item.zipCode,
    source: 'rentcast',
    title: `Rental market: ${item.zipCode}`,
    authors: [],
    hasFullText: true,
    description: rental
      ? `Average rent: $${rental.averageRent ?? 'n/a'}, median: $${rental.medianRent ?? 'n/a'}`
      : undefined,
  };
}

defineRest<RentcastMarket>({
  name: 'rentcast',
  description:
    'RentCast: US rental and sale market statistics by ZIP code. Requires free-tier RENTCAST_API_KEY (50 requests/month).',
  cluster: 'real_estate',
  freshness: 'daily',
  homepage: 'https://www.rentcast.io',
  supportsIngest: false,
  auth: { type: 'header', env: 'RENTCAST_API_KEY', header: 'X-Api-Key' },
  pacing: { dailyCap: 1 },
  search: {
    url: (q) => `${BASE}/markets?zipCode=${encodeURIComponent(q)}`,
    pick: (raw) => (raw ? [raw] : []),
    normalize: normalizeRentcast,
  },
  read: {
    url: (id) => `${BASE}/markets?zipCode=${encodeURIComponent(id)}`,
    normalize: (raw: RentcastMarket, id: string) => {
      const rental = raw?.rentalData;
      if (!rental) {
        return { title: id, authors: [], ...truncateText(`No market data found for ${id}.`) };
      }
      const text = [
        `ZIP: ${id}`,
        `Average rent: $${rental.averageRent ?? 'n/a'}`,
        `Median rent: $${rental.medianRent ?? 'n/a'}`,
        `Min rent: $${rental.minRent ?? 'n/a'}`,
        `Max rent: $${rental.maxRent ?? 'n/a'}`,
        `Total listings: ${rental.totalListings ?? 'n/a'}`,
      ].join('\n');
      return { title: `Rental market: ${id}`, authors: [], ...truncateText(text) };
    },
  },
});
