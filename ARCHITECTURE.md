# Architecture

## Pipeline (one path, no bypass)
```
scrape ─► score (≥70 gate) ─► NPPES size gate (free) ─► enrich (Clay waterfall)
       ─► write sequence (Sonnet, cluster-routed) ─► Cleanlist verify ─► SalesBlink send
       ─► reply ─► Close CRM handoff
```
- **scrape** — `pipeline/scrape.py` (JobSpy: Indeed live, LinkedIn actor; free boards). Dedupe on `sha1(company|title)`. 14-day window.
- **score** — `pipeline/score.py`, driven entirely by `lib/scoring/rubric.config.json`. Deterministic keyword pass; in production Claude Haiku refines the ambiguous 40–69 band using feedback few-shots. Same code path in cron and dashboard — the old app's two-scorer split (keyword in cron, "AI" on a button) is gone.
- **size gate** — free NPPES provider-count lookup before any paid credit. Kills hospitals/large orgs.
- **enrich → write → send** — Clay (waterfall), Sonnet sequences routed by title cluster (front_desk / billing_rcm / records_dataentry / general_va), Cleanlist verify, SalesBlink on warmed domains, Close on reply.

## The learning loop (eval-gated — the part the old app faked)
```
feedback ─► few-shot (pgvector kNN over feedback) ─► distilled learned_rules (decay/dedup)
        ─► candidate scoring_version ─► EVAL on locked 61-holdout ─► promote iff (≥ baseline AND ≥ 90% AND no worse false-disqualify)
```
- **Feedback** is first-class history (verdict + reason_tags + corrected_score + note), many per posting.
- **Eval gate** (`lib/eval/eval_holdout.py`): a candidate must beat the baseline on the frozen 61-entry human holdout before it goes active. Seed run: baseline (old AI) 67.2% / 20 lost → candidate (v1.0) 77.0% / 4 lost.
- **Active-learning queue**: postings nearest the 70 gate surface first (uncertainty sampling) so feedback effort is maximally useful.

## Single source of truth
`lib/scoring/rubric.config.json` — weights, flags, caps, gate, title clusters, outreach flags. Read by the Python scorer today and the TS scorer in the Next.js/Supabase build. The re-orientation from job-seeker → staffing-seller lives here (notably: US work-authorization is NOT a disqualifier; senior titles are; US coding certs deprioritize).

## Surfaces
- **web/** — the mobile-first DRY-RUN dashboard (static, deploys anywhere). Screens: Pipeline, Jobs, CRM, Review, Outreach, Learning, Tools, Settings, Why-better.
- **mcp/server.js** — Claude MCP server exposing the pipeline as tools (`list_leads`, `submit_feedback`, `run_eval`, `teach_rule`, `pipeline_status`, `learning_status`). Add to Claude Desktop/Code to operate the whole system conversationally.
- **db/migrations/** — real Postgres schema (`001_init.sql`, RLS policies) + a seed generator (`002_seed.py`) that loads the exact same 259 postings / 61 holdout / 7 learned rules the demo shows, so a fresh Supabase project starts identical to the DRY-RUN.
- **functions/api/** — Cloudflare Pages Functions (the real backend): `leads`, `feedback`, `pipeline-status`, `eval-run` (JS port of the eval harness, verified byte-for-byte parity with the Python version — 77% agreement / 4 false-disqualify on the same holdout), `teach-rule`, `notify-hot-leads`, `webhooks/enrichment`. All read `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` from Cloudflare Pages environment variables — never hardcoded.
- **.github/workflows/** — the 3 scraping cadences from the plan, as real scheduled GitHub Actions (free): `scrape-speed-sweep.yml` (every 3h, Indeed-only via `scrape.py --priority-only`), `scrape-daily-core.yml` (06:00 ET, full source set), `scrape-weekly-deep.yml` (Sundays, + `rescore_nurture.py` re-scores the nurture pool against the current rubric + triggers `/api/eval-run`).
- **lib/notify/adapters.js** — pluggable SDR notification layer (Slack / Zoho Cliq / generic webhook for WhatsApp-via-Twilio or Teams). Chat platform not yet chosen — swap `NOTIFY_CHANNEL` + `NOTIFY_WEBHOOK_URL` env vars, no code change needed.
- **Deploy target: Cloudflare Pages.** Static `web/` deploys today with zero dependencies. The `functions/` API layer goes live the moment `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `CRON_SECRET` are set as Cloudflare Pages environment variables — this is what turns real-time scraping + live SDR-visible contacts (name/LinkedIn/phone from Cleanlist) from stubbed to real.

## MCP quick add (Claude Desktop / Code)
```json
{ "mcpServers": { "lead-scraping-plan": { "command": "node", "args": ["<repo>/mcp/server.js"] } } }
```
