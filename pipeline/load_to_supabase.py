"""Pushes the newest scored_*.csv into Supabase via its REST API (upsert on dedupe_hash).
Run after scrape.py + score.py. Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in env
(set as GitHub Actions secrets, never committed).
"""
import csv
import os
import sys
from datetime import date
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent / "data"


def upsert_company(base, headers, name, location):
    r = requests.post(
        f"{base}/rest/v1/companies",
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=representation"},
        json={"name": name, "location": location},
    )
    if r.status_code not in (200, 201):
        # likely a conflict on normalized_name with nothing changed - fetch existing
        r2 = requests.get(f"{base}/rest/v1/companies", headers=headers,
                           params={"name": f"eq.{name}", "select": "id"})
        rows = r2.json()
        return rows[0]["id"] if rows else None
    rows = r.json()
    return rows[0]["id"] if rows else None


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        # Intentional no-op, not a failure: sys.exit(str) would exit 1 and fail the CI job.
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY not set - skipping Supabase load (safe no-op)")
        return

    scored = sorted(DATA_DIR.glob("scored_*.csv"))
    if not scored:
        sys.exit("no scored_*.csv found - run scrape.py + score.py first")
    src = scored[-1]

    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    inserted, skipped = 0, 0

    with open(src, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            company_id = upsert_company(url, headers, row["company"], row["location"])
            verdict_map = {"qualified": "qualified", "deprioritized": "nurture", "disqualified": "disqualified"}
            payload = {
                "company_id": company_id,
                "source": row["source"],
                "dedupe_hash": row["id"],
                "title": row["title"],
                "description": (row.get("description") or "")[:2000],
                "url": row["url"],
                "current_score": int(row["score"]),
                "current_verdict": verdict_map.get(row["verdict"], "disqualified"),
                "remote_signal": row["remote_signal"],
                "lead_state": verdict_map.get(row["verdict"], "disqualified"),
            }
            r = requests.post(
                f"{url}/rest/v1/job_postings",
                headers={**headers, "Prefer": "resolution=merge-duplicates"},
                json=payload,
            )
            if r.status_code in (200, 201):
                inserted += 1
            else:
                skipped += 1

    print(f"loaded {src.name}: {inserted} upserted, {skipped} skipped/errored")


if __name__ == "__main__":
    main()
