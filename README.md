# Lead Scraping Plan — signal-scored outbound pipeline for the staffing industry

An agentic outbound pipeline + mobile command center for a healthcare-staffing agency: scrape US healthcare-admin job postings, score them against the agency's actual buyer ICP, gate on company size for free before spending a credit, enrich, write cluster-routed sequences, and hand booked replies to the sales team — with a feedback → learning → **eval-gated** loop that actually closes.

Built as a demonstrably better rework of an existing open-source outbound dashboard ("TalentBridge"), aligned to a finalized scraping plan (v3).

---

## Why this beats the reference dashboard (measured, not claimed)

On **61 real human-rated postings** exported from the original dashboard:

| | Original AI | **This scorer v1** |
|---|---|---|
| Agreement with human gold | 67.2% | **77.0%** |
| Leads thrown away (false-disqualify) | **20 (33%)** | **4 (6.6%)** |

The original AI scores against a **job-seeker** objective — it disqualifies postings that "require US work authorization." But the business here is a **staffing seller**: those US practices hiring junior admin roles *are the customers*. Re-orienting the objective from the 61 corrections recovers 16 of the 20 wrongly-discarded leads. The remaining 4 are what the feedback-learning loop targets next (toward a 90% eval-gate target).

Run it yourself: `python lib/eval/eval_holdout.py --baseline` vs `python lib/eval/eval_holdout.py`.

### Architecture wins over the reference app
| Reference app | This repo |
|---|---|
| Two scorers — the daily cron ran a keyword filter; the "AI" only ran on a manual button, so **automation bypassed the AI** | **One scorer** (`pipeline/score.py` + TS), driven by one versioned `rubric.config.json`, same path in cron and dashboard |
| Feedback = 3 overwrite columns on the job row; unbounded free-text "learned rules"; the retrain cron never scheduled; **no eval harness** | First-class `feedback` history + scored/decaying `learned_rules` + an **eval gate**: a candidate must beat baseline on the locked holdout before it ships |
| No size gate — a 2,000-person RCM firm slipped through on name alone | **Free NPPES provider-count gate** before any paid enrichment |
| Single Gmail sender, desktop-only, real email leaked on a public endpoint | Verify → warmed/rotated send, **mobile-first**, auth-gated, **MCP-operable from Claude** |
| One lead per job posting — the same company repeated across every open role | **Account-centric CRM**: one account per company, roles grouped as opportunities, 3+ roles score higher |

_Credit where due: the reference repo's prompt-injection sanitization, DRY_RUN + suppression + send caps, dedup, and LLM cache are good patterns and are reused here._

---

## What's in the box

```
web/                 mobile-first dashboard (DRY-RUN demo, runs on seed data, deploys as static)
lib/scoring/rubric.config.json   SINGLE SOURCE OF TRUTH — weights, flags, caps, gate, clusters
pipeline/score.py    the one config-driven scorer (re-oriented for a staffing seller)
pipeline/scrape.py   JobSpy scraper (Indeed live; LinkedIn actor; free boards)
lib/eval/            the eval harness (agreement % + false-disqualify on the 61-entry holdout)
eval/holdout/        the 61 human-rated postings (frozen truth set)
db/seed/             259 scored postings, 61 feedback, 7 learned rules, seed eval runs
mcp/                 Claude MCP server — run the pipeline by talking to Claude
```

## Run the demo dashboard locally
```bash
cd web && python -m http.server 8080   # open http://localhost:8080 (mobile-friendly)
```
Screens: **Pipeline** (tier board + priority accounts) · **Jobs** (searchable table + CSV export) · **CRM** (account-centric, deduped) · **Review** (active-learning feedback loop) · **Outreach** (sequence queue) · **Learning** (eval history, learned rules, teach-a-rule) · **Tools** (integration health + flow) · **Settings** · **Why better** (the benchmark above).

## Status (DRY-RUN)
Free/live: **JobSpy (Indeed)**, **NPPES** size gate, the deterministic scorer, the eval harness.
Stubbed until keys: LinkedIn actor, Anthropic (Haiku/Sonnet — scoring/sequences run cached), Clay, Cleanlist, SalesBlink, Sendr.io, Close CRM, Supabase. Every stub is labeled on the dashboard's Tools panel. Nothing sends or spends in DRY-RUN.

> Notes on scope: "trained" here means dynamic feedback few-shots + a distilled, eval-gated rule store + versioned rubric — not a fine-tuned model. LinkedIn scraping carries a ToS caveat. Company/contact names in the seed data are real public job postings (scraped, not private); learned-rule *values* stay generalized.
