-- Lead Scraping & Scoring Pipeline — initial schema (Supabase/Postgres)
-- Run in Supabase SQL editor, or via `supabase db push`. Requires pgvector for §8.

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- 1. companies — dedup anchor, one row per employer
create table companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  normalized_name text generated always as (lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'))) stored,
  domain text,
  location text,
  nppes_provider_count int,
  nppes_org_type text,
  nppes_checked_at timestamptz,
  size_band text check (size_band in ('solo_small','mid','large','billing_rcm','unknown')) default 'unknown',
  is_excluded boolean default false,
  exclusion_reason text,
  open_roles_count int default 0,
  is_multi_location boolean default false,
  priority_account boolean generated always as (open_roles_count >= 3 or is_multi_location) stored,
  suppressed boolean default false,
  suppressed_reason text,
  suppressed_at timestamptz,
  created_at timestamptz default now()
);
create unique index companies_normalized_name_idx on companies(normalized_name);

-- 2. job_postings — one row per scraped posting
create table job_postings (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  source text not null,                       -- indeed | linkedin | remotive | jobicy | remoteok
  external_id text,
  dedupe_hash text not null,                  -- sha1(company+title), matches pipeline/scrape.py
  title text not null,
  title_cluster text check (title_cluster in ('front_desk','billing_rcm','records_dataentry','general_va')),
  description text,
  url text,
  date_posted date,
  is_remote boolean,
  salary_min numeric,
  salary_max numeric,
  salary_period text check (salary_period in ('hourly','yearly', null)),
  current_score int,
  current_verdict text check (current_verdict in ('qualified','nurture','disqualified')),
  remote_signal text,
  scored_by_version_id uuid,
  scored_at timestamptz,
  lead_state text default 'scraped' check (lead_state in
    ('scraped','scored','qualified','nurture','archived','size_gate_pass','size_gate_fail',
     'enriched','sequenced','approved','sending','replied','crm_handoff')),
  scraped_at timestamptz default now()
);
create unique index job_postings_dedupe_idx on job_postings(dedupe_hash);
create index job_postings_company_idx on job_postings(company_id);
create index job_postings_score_idx on job_postings(current_score desc);

-- 3. scores — append-only scoring history (never overwrite)
create table scores (
  id uuid primary key default uuid_generate_v4(),
  job_posting_id uuid references job_postings(id) not null,
  scoring_version_id uuid,
  score int not null,
  verdict text not null,
  reasons jsonb,
  model text check (model in ('keyword','haiku')),
  few_shot_ids uuid[],
  created_at timestamptz default now()
);
create index scores_posting_idx on scores(job_posting_id);

-- 4. feedback — first-class, many rows per posting, multi-annotator
create table feedback (
  id uuid primary key default uuid_generate_v4(),
  job_posting_id uuid references job_postings(id) not null,
  annotator text,
  verdict text check (verdict in ('agree','too_high','too_low','wrong_disqualify','wrong_qualify')) not null,
  corrected_score int,
  reason_tags text[],
  note text,
  created_at timestamptz default now()
);
create index feedback_posting_idx on feedback(job_posting_id);

-- 5. scoring_versions — the rubric/prompt as a versioned artifact, single source of truth
create table scoring_versions (
  id uuid primary key default uuid_generate_v4(),
  semver text not null,
  rubric_config jsonb not null,
  prompt_template text,
  parent_version_id uuid references scoring_versions(id),
  status text check (status in ('draft','shadow','active','archived')) default 'draft',
  created_by text,
  created_at timestamptz default now(),
  promoted_at timestamptz,
  notes text
);
create unique index one_active_version on scoring_versions((status = 'active')) where status = 'active';

-- 6. learned_rules — scored, decaying, deduped
create table learned_rules (
  id uuid primary key default uuid_generate_v4(),
  rule_text text not null,
  rule_type text check (rule_type in ('disqualifier','red_flag','green_flag','cap','size_hint')),
  pattern text,
  weight int default 0,
  confidence numeric(3,2),
  support_count int default 0,
  contradiction_count int default 0,
  last_reinforced_at timestamptz default now(),
  decay_score numeric(4,2) default 1.0,
  status text check (status in ('candidate','validated','active','retired')) default 'candidate',
  source_feedback_ids uuid[],
  created_at timestamptz default now()
);

-- 7. eval_runs — the regression harness ledger
create table eval_runs (
  id uuid primary key default uuid_generate_v4(),
  candidate_version_id uuid references scoring_versions(id),
  baseline_version_id uuid references scoring_versions(id),
  holdout_set_id text,
  agreement_pct numeric(5,2),
  precision_qualified numeric(5,2),
  recall_qualified numeric(5,2),
  false_disqualify_rate numeric(5,2),
  n_labeled int,
  decision text check (decision in ('promote','reject')),
  per_item jsonb,
  created_at timestamptz default now()
);

-- 8. labeled_holdout — the frozen truth set (61 real entries + growth)
create table labeled_holdout (
  id uuid primary key default uuid_generate_v4(),
  job_posting_id uuid references job_postings(id),
  gold_verdict text not null,
  gold_score int,
  labeled_by text,
  locked boolean default true,
  set_name text default 'v1_61',
  created_at timestamptz default now()
);

-- 8b. posting_embeddings — for few-shot retrieval (pgvector)
create table posting_embeddings (
  job_posting_id uuid primary key references job_postings(id),
  embedding vector(1536)
);
create index posting_embeddings_ivfflat on posting_embeddings using ivfflat (embedding vector_cosine_ops);

-- 9. contacts — enrichment output (Cleanlist/Clay)
create table contacts (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) not null,
  name text,
  title text,
  title_role text,                            -- matched decision-maker role (owner, office_manager, etc.)
  linkedin_url text,
  email text,
  email_verified_status text check (email_verified_status in ('verified','unverified','invalid','risky')),
  phone text,
  enriched_by text,                            -- clay | cleanlist
  enrichment_source text,
  created_at timestamptz default now()
);
create index contacts_company_idx on contacts(company_id);

-- 10. sequences + sequence_touches — generated copy + approval + send state
create table sequences (
  id uuid primary key default uuid_generate_v4(),
  contact_id uuid references contacts(id) not null,
  title_cluster text,
  status text check (status in ('draft','approved','sending','replied','stopped')) default 'draft',
  generated_by_model text,
  approved_by text,
  created_at timestamptz default now()
);
create table sequence_touches (
  id uuid primary key default uuid_generate_v4(),
  sequence_id uuid references sequences(id) not null,
  touch_number int check (touch_number between 1 and 5),
  subject text,
  body text,
  ab_variant text,
  send_at timestamptz,
  sent_at timestamptz,
  provider_msg_id text
);

-- 11. integrations — health panel backing table
create table integrations (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,                   -- jobspy, nppes, clay, cleanlist, salesblink, sendr, close, anthropic, supabase
  status text check (status in ('live','stubbed','degraded','down')) default 'stubbed',
  mode text check (mode in ('live','dry_run')) default 'dry_run',
  last_ok_at timestamptz,
  last_error text,
  credential_present boolean default false
);
insert into integrations (name, status, mode, credential_present) values
  ('jobspy', 'live', 'live', true),
  ('nppes', 'live', 'live', true),
  ('anthropic', 'stubbed', 'dry_run', false),
  ('clay', 'stubbed', 'dry_run', false),
  ('cleanlist', 'stubbed', 'dry_run', false),
  ('salesblink', 'stubbed', 'dry_run', false),
  ('sendr', 'stubbed', 'dry_run', false),
  ('close', 'stubbed', 'dry_run', false),
  ('supabase', 'live', 'live', true);

-- 12. lead_events — audit trail + funnel counts
create table lead_events (
  id uuid primary key default uuid_generate_v4(),
  job_posting_id uuid references job_postings(id) not null,
  from_state text,
  to_state text not null,
  agent text,                                  -- scout | scorer | enricher | writer | human
  cost numeric(8,4) default 0,
  result jsonb,
  created_at timestamptz default now()
);
create index lead_events_posting_idx on lead_events(job_posting_id);

-- Row Level Security: lock down everything except the one public read the landing page needs.
alter table companies enable row level security;
alter table job_postings enable row level security;
alter table scores enable row level security;
alter table feedback enable row level security;
alter table contacts enable row level security;
alter table sequences enable row level security;
alter table sequence_touches enable row level security;
alter table integrations enable row level security;
alter table lead_events enable row level security;

create policy "authenticated read/write" on job_postings for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on companies for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on scores for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on feedback for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on contacts for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on sequences for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on sequence_touches for all using (auth.role() = 'authenticated');
create policy "authenticated read/write" on lead_events for all using (auth.role() = 'authenticated');
create policy "public read integrations health" on integrations for select using (true);
