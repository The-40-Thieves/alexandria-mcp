// THE-311: a daily usage cap per source, backed by an in-memory store by
// default or (when configured) a Supabase table shared across processes.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class QuotaExceededError extends Error {
  constructor(public source: string, public used: number, public cap: number) {
    super(`Daily quota for ${source} reached (${used}/${cap}). Try again after 00:00 UTC.`);
  }
}

export interface LedgerStore {
  get(source: string, day: string): Promise<number>;
  increment(source: string, day: string): Promise<number>;
}

export class MemoryLedgerStore implements LedgerStore {
  private counts = new Map<string, number>();

  async get(source: string, day: string): Promise<number> {
    return this.counts.get(`${source}:${day}`) ?? 0;
  }

  async increment(source: string, day: string): Promise<number> {
    const key = `${source}:${day}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

// Backed by the `quota_ledger` table + `increment_quota` RPC in
// docs/sql/quota_ledger.sql.
export class SupabaseLedgerStore implements LedgerStore {
  private client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey);
  }

  async get(source: string, day: string): Promise<number> {
    const { data, error } = await this.client
      .from('quota_ledger')
      .select('count')
      .eq('source', source)
      .eq('day', day)
      .maybeSingle();
    if (error) throw new Error(`quota_ledger read failed: ${error.message}`);
    return data?.count ?? 0;
  }

  async increment(source: string, day: string): Promise<number> {
    const { data, error } = await this.client.rpc('increment_quota', {
      p_source: source,
      p_day: day,
    });
    if (error) throw new Error(`increment_quota failed: ${error.message}`);
    return data as number;
  }
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function createLedger(): LedgerStore {
  const { ALEXANDRIA_LEDGER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (ALEXANDRIA_LEDGER === 'supabase' && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseLedgerStore(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return new MemoryLedgerStore();
}

export async function enforceQuota(
  source: string,
  cap: number | undefined,
  store: LedgerStore,
): Promise<void> {
  if (cap === undefined) return;
  const used = await store.get(source, utcDay());
  if (used >= cap) throw new QuotaExceededError(source, used, cap);
}

export async function recordUsage(source: string, store: LedgerStore): Promise<void> {
  await store.increment(source, utcDay());
}
