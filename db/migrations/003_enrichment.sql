-- Tracks every enrichment request WE submitted to Cleanlist, keyed by their workflow_id.
-- Required because Cleanlist does not sign its webhook payloads (confirmed in their docs) —
-- the webhook handler checks incoming workflow_id against this table before trusting it,
-- so a forged/replayed webhook with a random workflow_id can't write fake contacts.

create table enrichment_requests (
  workflow_id text primary key,
  company_id uuid references companies(id) not null,
  contact_query jsonb,                 -- what we submitted (name/email/linkedin used as the identifier)
  provider text default 'cleanlist',
  status text default 'pending' check (status in ('pending','completed','completed_with_errors','failed')),
  submitted_at timestamptz default now(),
  completed_at timestamptz
);
create index enrichment_requests_company_idx on enrichment_requests(company_id);

alter table enrichment_requests enable row level security;
create policy "authenticated read/write" on enrichment_requests for all using (auth.role() = 'authenticated');
