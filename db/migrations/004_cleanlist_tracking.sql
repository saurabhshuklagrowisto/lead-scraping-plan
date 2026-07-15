-- Avoids repeat 1-credit company-confirm spend on a company we've already checked with Cleanlist.
alter table companies add column if not exists cleanlist_checked_at timestamptz;
