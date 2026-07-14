"""Scout stage 1 — scrape US healthcare-admin job postings from all sources.

Sources: Indeed/ZipRecruiter/Google via JobSpy; Remotive, Jobicy, RemoteOK via
free public APIs. Output: data/jobs_raw.csv (one normalized schema, deduped).
"""
import csv
import hashlib
import html
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# Compact query set — each JobSpy search costs time, so queries group the
# 25 target titles into high-recall searches. Full list: memory/icp-and-scoring/job-titles.md
JOBSPY_QUERIES = [
    "medical receptionist",
    "patient service representative",
    "appointment scheduler medical",
    "patient care coordinator",
    "medical administrative assistant",
    "medical records clerk",
    "insurance verification specialist",
    "prior authorization specialist",
    "medical biller",
    "medical billing specialist",
    "medical claims specialist",
    "revenue cycle specialist",
    "referral coordinator medical",
    "dental receptionist",
    "medical virtual assistant",
]

# Broad keyword nets for the remote boards (they have low healthcare volume,
# so search wide and let the scorer filter).
BOARD_KEYWORDS = ["medical", "healthcare", "dental", "patient", "billing", "clinic"]

TITLE_MATCH = re.compile(
    r"(medical|dental|patient|health|clinic|insurance verification|prior auth|"
    r"revenue cycle|claims|billing|biller|receptionist|scheduler|intake|referral)",
    re.I,
)

FIELDS = [
    "id", "source", "title", "company", "location", "is_remote",
    "date_posted", "url", "description",
]


def _s(v) -> str:
    """Coerce to str; pandas hands us float('nan') for missing fields."""
    if v is None or (isinstance(v, float) and v != v):
        return ""
    return str(v)


def norm(job: dict) -> dict:
    """Normalize a job dict and derive a stable dedupe id."""
    job = {k: _s(v) if not isinstance(v, bool) else v for k, v in job.items()}
    company = job.get("company", "").strip()
    title = job.get("title", "").strip()
    job["id"] = hashlib.sha1(f"{company.lower()}|{title.lower()}".encode()).hexdigest()[:12]
    desc = html.unescape(re.sub(r"<[^>]+>", " ", job.get("description") or ""))
    job["description"] = re.sub(r"\s+", " ", desc).strip()[:4000]
    return {k: job.get(k, "") for k in FIELDS}


def from_remotive() -> list[dict]:
    out = []
    for kw in BOARD_KEYWORDS:
        try:
            r = requests.get(
                "https://remotive.com/api/remote-jobs",
                params={"search": kw, "limit": 50}, timeout=30,
            )
            for j in r.json().get("jobs", []):
                loc = j.get("candidate_required_location", "")
                if "USA" not in loc and "United States" not in loc and "Worldwide" not in loc:
                    continue
                out.append(norm({
                    "source": "remotive", "title": j.get("title"),
                    "company": j.get("company_name"), "location": loc,
                    "is_remote": True, "date_posted": (j.get("publication_date") or "")[:10],
                    "url": j.get("url"), "description": j.get("description"),
                }))
        except Exception as e:
            print(f"[remotive:{kw}] {e}", file=sys.stderr)
        time.sleep(1)
    return out


def from_jobicy() -> list[dict]:
    out = []
    try:
        r = requests.get(
            "https://jobicy.com/api/v2/remote-jobs",
            params={"count": 100, "geo": "usa"}, timeout=30,
        )
        for j in r.json().get("jobs", []):
            title = j.get("jobTitle", "")
            if not TITLE_MATCH.search(title + " " + j.get("jobExcerpt", "")):
                continue
            out.append(norm({
                "source": "jobicy", "title": title,
                "company": j.get("companyName"), "location": j.get("jobGeo", ""),
                "is_remote": True, "date_posted": (j.get("pubDate") or "")[:10],
                "url": j.get("url"), "description": j.get("jobDescription") or j.get("jobExcerpt"),
            }))
    except Exception as e:
        print(f"[jobicy] {e}", file=sys.stderr)
    return out


def from_remoteok() -> list[dict]:
    out = []
    try:
        r = requests.get(
            "https://remoteok.com/api",
            headers={"User-Agent": "Mozilla/5.0"}, timeout=30,
        )
        for j in r.json()[1:]:
            if not isinstance(j, dict):
                continue
            text = f'{j.get("position", "")} {j.get("description", "")}'
            if not TITLE_MATCH.search(text):
                continue
            loc = (j.get("location") or "").lower()
            if loc and not any(t in loc for t in ("united states", "usa", "us", "north america", "worldwide", "anywhere", "remote")):
                continue
            out.append(norm({
                "source": "remoteok", "title": j.get("position"),
                "company": j.get("company"), "location": j.get("location", "Remote"),
                "is_remote": True, "date_posted": (j.get("date") or "")[:10],
                "url": j.get("url"), "description": j.get("description"),
            }))
    except Exception as e:
        print(f"[remoteok] {e}", file=sys.stderr)
    return out


def from_jobspy() -> list[dict]:
    try:
        from jobspy import scrape_jobs
    except ImportError:
        print("[jobspy] not installed in this interpreter — skipping Indeed", file=sys.stderr)
        return []
    out = []
    for q in JOBSPY_QUERIES:
        try:
            df = scrape_jobs(
                site_name=["indeed"], search_term=q, location="United States",
                results_wanted=25, hours_old=24 * 14, country_indeed="USA",
                description_format="markdown",
            )
            for _, row in df.iterrows():
                out.append(norm({
                    "source": "indeed", "title": row.get("title"),
                    "company": row.get("company"),
                    "location": str(row.get("location") or ""),
                    "is_remote": bool(row.get("is_remote")),
                    "date_posted": str(row.get("date_posted") or ""),
                    "url": row.get("job_url"),
                    "description": str(row.get("description") or ""),
                }))
            print(f"[indeed:{q}] {len(df)} jobs")
        except Exception as e:
            print(f"[indeed:{q}] {e}", file=sys.stderr)
        time.sleep(2)
    return out


def main() -> None:
    jobs: dict[str, dict] = {}
    for fetch in (from_jobspy, from_remotive, from_jobicy, from_remoteok):
        batch = fetch()
        for j in batch:
            jobs.setdefault(j["id"], j)          # dedupe on company+title
        print(f"{fetch.__name__}: {len(batch)} rows ({len(jobs)} unique so far)")

    out = DATA_DIR / f"jobs_raw_{date.today().isoformat()}.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(jobs.values())
    print(f"wrote {len(jobs)} unique jobs -> {out}")


if __name__ == "__main__":
    main()
