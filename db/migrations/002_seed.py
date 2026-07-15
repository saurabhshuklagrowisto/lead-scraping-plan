"""Generates 002_seed.sql from the existing demo data (scored_seed.csv, feedback_61.json,
learned_rules.json, eval_runs.json) so a fresh Supabase project starts with the exact same
259 postings / 61 labeled holdout / 7 learned rules the DRY-RUN dashboard already shows.

Run once: python db/migrations/002_seed.py   ->  writes 002_seed.sql (apply after 001_init.sql)
"""
import csv, json, hashlib, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def esc(s):
    if s is None:
        return "null"
    return "'" + str(s).replace("'", "''") + "'"


def norm_company(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def main():
    leads = list(csv.DictReader(open(ROOT / "db/seed/scored_seed.csv", encoding="utf-8")))
    feedback = json.load(open(ROOT / "eval/holdout/feedback_61.json", encoding="utf-8"))["entries"]
    rules = json.load(open(ROOT / "db/seed/learned_rules.json", encoding="utf-8"))["rules"]

    lines = ["-- Auto-generated seed data. Apply after 001_init.sql.", "begin;", ""]

    # companies (dedup by normalized name)
    companies = {}
    for l in leads:
        key = norm_company(l["company"])
        if key and key not in companies:
            companies[key] = l["company"]
    lines.append("-- companies")
    for key, name in companies.items():
        lines.append(
            f"insert into companies (name, location) values ({esc(name)}, "
            f"{esc(next((l['location'] for l in leads if norm_company(l['company'])==key), None))}) "
            f"on conflict (normalized_name) do nothing;"
        )
    lines.append("")

    # job_postings, referencing company by normalized name via subquery
    lines.append("-- job_postings")
    for l in leads:
        ckey = norm_company(l["company"])
        verdict = {"qualified": "qualified", "deprioritized": "nurture", "disqualified": "disqualified"}.get(l["verdict"], "disqualified")
        lines.append(
            "insert into job_postings (company_id, source, dedupe_hash, title, description, url, "
            "is_remote, current_score, current_verdict, remote_signal, lead_state) values ("
            f"(select id from companies where normalized_name = {esc(ckey)}), "
            f"{esc(l['source'])}, {esc(l['id'])}, {esc(l['title'])}, {esc((l['description'] or '')[:2000])}, "
            f"{esc(l['url'])}, {str(l['remote_signal']=='explicit-remote').lower()}, {int(l['score'])}, "
            f"{esc(verdict)}, {esc(l['remote_signal'])}, {esc(verdict)}) "
            "on conflict (dedupe_hash) do nothing;"
        )
    lines.append("")

    # labeled_holdout (the 61) — matched by title+company best-effort; falls back to a synthetic posting row
    lines.append("-- labeled_holdout (the 61 real human-rated entries)")
    for f in feedback:
        gold = f["gold_verdict"]
        lines.append(
            "insert into job_postings (source, dedupe_hash, title, description, current_score, current_verdict) "
            f"values ('holdout', {esc('holdout-'+str(f['id']))}, {esc(f['title'])}, {esc(f['note'])}, "
            f"{f['rating']*20}, {esc(gold)}) on conflict (dedupe_hash) do nothing;"
        )
        lines.append(
            "insert into labeled_holdout (job_posting_id, gold_verdict, gold_score, labeled_by, set_name) values ("
            f"(select id from job_postings where dedupe_hash = {esc('holdout-'+str(f['id']))}), "
            f"{esc(gold)}, {f['rating']*20}, 'human_rlhf_export', 'v1_61');"
        )
    lines.append("")

    # scoring_versions — v1.0.0 active
    rubric = json.load(open(ROOT / "lib/scoring/rubric.config.json", encoding="utf-8"))
    lines.append("-- scoring_versions")
    lines.append(
        "insert into scoring_versions (semver, rubric_config, status, created_by, promoted_at) values ("
        f"'1.0.0', {esc(json.dumps(rubric))}::jsonb, 'active', 'saurabh', now());"
    )
    lines.append("")

    # learned_rules
    lines.append("-- learned_rules")
    for r in rules:
        lines.append(
            "insert into learned_rules (rule_text, rule_type, pattern, weight, confidence, support_count, "
            "contradiction_count, status) values ("
            f"{esc(r['rule_text'])}, {esc(r['rule_type'])}, {esc(r.get('pattern'))}, {r['weight']}, "
            f"{r['confidence']}, {r['support_count']}, {r['contradiction_count']}, {esc(r['status'])});"
        )
    lines.append("")
    lines.append("commit;")

    out = ROOT / "db/migrations/002_seed.sql"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out} ({len(lines)} lines, {len(companies)} companies, {len(leads)} postings, {len(feedback)} holdout entries)")


if __name__ == "__main__":
    main()
