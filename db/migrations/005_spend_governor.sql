-- Hard cost ceiling for all paid enrichment spend: $5/week, $20/month (Cleanlist credit packs
-- are a flat $0.10/credit — see lib/integrations/cleanlist.js CREDIT_COST_USD). Every credit
-- spent (or about to be spent) is logged here BEFORE the Cleanlist call fires, so the governor
-- in enrich-lead.js can always answer "how much have we spent this week/month" with a single
-- query and refuse the call before it costs anything.

create table spend_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  contact_id uuid references contacts(id),
  purpose text not null check (purpose in ('company_confirm', 'phone_only', 'partial_email', 'full')),
  credits numeric not null,
  usd numeric not null,
  created_at timestamptz default now()
);
create index spend_ledger_created_idx on spend_ledger(created_at);

alter table spend_ledger enable row level security;
create policy "authenticated read/write" on spend_ledger for all using (auth.role() = 'authenticated');
