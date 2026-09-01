-- THE-311: daily usage cap per source, shared across processes.
--
-- Used by src/utils/quotaLedger.ts's SupabaseLedgerStore, selected when
-- ALEXANDRIA_LEDGER=supabase and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
-- are set. The default (no env set) is an in-memory store scoped to the
-- current process.

create table if not exists quota_ledger (
  source text not null,
  day date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (source, day)
);

create or replace function increment_quota(p_source text, p_day date)
returns integer
language sql
as $$
  insert into quota_ledger (source, day, count, updated_at)
  values (p_source, p_day, 1, now())
  on conflict (source, day)
  do update set count = quota_ledger.count + 1, updated_at = now()
  returning count;
$$;
