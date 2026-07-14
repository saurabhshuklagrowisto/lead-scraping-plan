"""Eval harness — the gate the old repo never had.

Scores the 61-entry human-labeled holdout with a rubric config and reports
agreement % vs the human gold verdict + false-disqualify rate. Run with the
re-oriented config (candidate) vs the old job-seeker config (baseline) to prove
the re-orientation recovers the leads their AI threw away.

Usage:
  python lib/eval/eval_holdout.py                 # score with active rubric
  python lib/eval/eval_holdout.py --old           # simulate old job-seeker rubric (US-auth = disqualify)
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
import score as scorer  # noqa: E402

HOLDOUT = ROOT / "eval" / "holdout" / "feedback_61.json"


def gold_good(v: str) -> bool:
    return v in ("qualified", "nurture")


def run(baseline: bool = False) -> dict:
    """baseline=True scores using the OLD AI's real stored verdicts (ai_verdict).
    baseline=False scores using our re-oriented config-driven scorer."""
    cfg = scorer.load_config()
    data = json.loads(HOLDOUT.read_text(encoding="utf-8"))
    entries = data["entries"]
    agree = 0
    false_disq = 0  # human wanted it (gold good) but this system rejected it = lost lead
    misses = []
    for e in entries:
        if baseline:
            pred_good = e["ai_verdict"] == "relevant"
            pred_label = e["ai_verdict"]
        else:
            # text proxy = title + human note (the 61 have no scraped description)
            res = scorer.score_job(e["title"], e["note"], e["company"], cfg)
            pred_good = res["verdict"] in ("qualified", "nurture")
            pred_label = res["verdict"]
        g = gold_good(e["gold_verdict"])
        if pred_good == g:
            agree += 1
        else:
            misses.append((e["id"], e["title"][:38], e["company"][:20], pred_label, e["gold_verdict"]))
        if g and not pred_good:
            false_disq += 1
    n = len(entries)
    return {
        "system": "OLD TalentBridge AI (real verdicts)" if baseline else "NEW QuickTeam scorer",
        "n": n,
        "agreement_pct": round(100 * agree / n, 1),
        "false_disqualify": false_disq,
        "false_disqualify_pct": round(100 * false_disq / n, 1),
        "misses": misses,
    }


if __name__ == "__main__":
    baseline = "--old" in sys.argv or "--baseline" in sys.argv
    r = run(baseline=baseline)
    print(f"\n=== {r['system']} ===")
    print(f"agreement with human gold : {r['agreement_pct']}%  ({r['n']} labeled)")
    print(f"false-disqualifies (leads thrown away): {r['false_disqualify']} ({r['false_disqualify_pct']}%)")
    if r["misses"]:
        print("misses:")
        for m in r["misses"][:20]:
            print(f"  #{m[0]:>2} {m[1]:<38} {m[2]:<20} pred={m[3]:<12} gold={m[4]}")
