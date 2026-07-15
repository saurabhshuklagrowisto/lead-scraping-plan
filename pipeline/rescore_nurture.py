"""Weekly deep job: re-scores every 'nurture' posting already in Supabase against the
CURRENT active rubric (which may have moved since the posting was first scored, e.g. a
learned rule was promoted). Writes an append-only `scores` history row and updates the
job_posting's current_score/current_verdict only if it changed.

Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in env.
"""
import os
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from score import score_job  # noqa: E402


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_KEY not set - skipping (safe no-op for local runs)")

    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    r = requests.get(f"{url}/rest/v1/scoring_versions", headers=headers, params={"status": "eq.active", "select": "id,rubric_config"})
    versions = r.json()
    if not versions:
        sys.exit("no active scoring_version found in Supabase")
    version_id, cfg = versions[0]["id"], versions[0]["rubric_config"]

    r = requests.get(
        f"{url}/rest/v1/job_postings", headers=headers,
        params={"current_verdict": "eq.nurture", "select": "id,title,description,companies(name)"},
    )
    postings = r.json()

    changed = 0
    for p in postings:
        company = (p.get("companies") or {}).get("name", "") if isinstance(p.get("companies"), dict) else ""
        res = score_job(p["title"], p.get("description") or "", company, cfg)
        requests.post(f"{url}/rest/v1/scores", headers=headers, json={
            "job_posting_id": p["id"], "scoring_version_id": version_id,
            "score": res["score"], "verdict": res["verdict"], "reasons": res["reasons"], "model": "keyword",
        })
        if res["verdict"] != "nurture":
            requests.patch(
                f"{url}/rest/v1/job_postings", headers=headers,
                params={"id": f"eq.{p['id']}"},
                json={"current_score": res["score"], "current_verdict": res["verdict"], "lead_state": res["verdict"]},
            )
            changed += 1

    print(f"re-scored {len(postings)} nurture postings, {changed} moved to a new verdict")


if __name__ == "__main__":
    main()
