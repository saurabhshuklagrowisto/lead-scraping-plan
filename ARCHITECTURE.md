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
- **functions/api/** — Cloudflare Pages Functions (the real backend): `leads`, `feedback`, `pipeline-status`, `eval-run` (JS port of the eval harness, verified byte-for-byte parity with the Python version — 77% agreement / 4 false-disqualify on the same holdout), `teach-rule`, `notify-hot-leads`, `enrich-lead`, `webhooks/enrichment`. All read `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` from Cloudflare Pages environment variables — never hardcoded.
- **lib/integrations/cleanlist.js** — real Cleanlist.ai client (`docs.cleanlist.ai`): synchronous company lookup (1 credit, confirms domain/size before spending more — same principle as the free NPPES gate), async person lookup (`partial` email-only = 1 credit, `full` email+phone = 11 credits) that delivers via webhook. **Cleanlist does not sign its webhook payloads** — `functions/api/webhooks/enrichment.js` defends against forged/replayed calls by checking every incoming `workflow_id` against `enrichment_requests` (a table of workflow_ids we actually submitted) before writing any contact; unknown IDs are rejected outright. Requires `CLEANLIST_API_KEY` + `APP_URL` (for the webhook callback URL) as Cloudflare Pages env vars.
  **Cost controls in `functions/api/enrich-lead.js`** (measured 33% credit savings on the current seed, more at scale): (1) refuses to spend if the company was already excluded by the free NPPES gate; (2) dedup cache — skips companies that already hit their contact cap; (3) contact cap by size (2 solo/small, 3 mid, matching the plan); (4) **tiered depth — `full` (11 credits, includes phone) only for priority accounts (3+ roles); every other qualified lead gets `partial` (1 credit, email + LinkedIn only)**, an 11x saving on the long tail, since a phone number for a single-role lead is rarely used. `force_full` param available to manually upgrade a lead later (e.g. after a reply).
- **.github/workflows/** — the 3 scraping cadences from the plan, as real scheduled GitHub Actions (free): `scrape-speed-sweep.yml` (every 3h, Indeed-only via `scrape.py --priority-only`), `scrape-daily-core.yml` (06:00 ET, full source set), `scrape-weekly-deep.yml` (Sundays, + `rescore_nurture.py` re-scores the nurture pool against the current rubric + triggers `/api/eval-run`).
- **lib/notify/adapters.js** — SDR notification layer, **Slack confirmed as the platform**, using real Slack Block Kit (clickable "Open in CRM" button, not just plain text). Cliq/generic-webhook adapters kept as a fallback if that ever changes — swap `NOTIFY_CHANNEL` (defaults to `slack`) with no code change. Setup: Slack workspace → Apps → **Incoming Webhooks** → Add New Webhook to Workspace → pick the channel → copy the URL into Cloudflare Pages env var `NOTIFY_WEBHOOK_URL`. Two minutes, no OAuth app needed.
- **Deploy target: Cloudflare Pages.** Static `web/` deploys today with zero dependencies. The `functions/` API layer goes live the moment `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `CRON_SECRET` are set as Cloudflare Pages environment variables — this is what turns real-time scraping + live SDR-visible contacts (name/LinkedIn/phone from Cleanlist) from stubbed to real.

## MCP quick add (Claude Desktop / Code)
```json
{ "mcpServers": { "lead-scraping-plan": { "command": "node", "args": ["<repo>/mcp/server.js"] } } }
```
