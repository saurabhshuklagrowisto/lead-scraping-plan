"""Config-driven ICP scorer — the SINGLE scorer (fixes the old repo's two-scorer split).

Loads lib/scoring/rubric.config.json (the one source of truth, shared with the TS
scorer) and scores a posting deterministically. In production a Claude (Haiku) pass
refines the ambiguous 40-69 band using feedback few-shots; the rubric, gate, and
output schema are identical, so demo output == real output shape.

Re-oriented for QuickTeam (staffing seller) using 61 real human corrections.
"""
import json
import re
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[1] / "lib" / "scoring" / "rubric.config.json"


def load_config(path: Path = CONFIG_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _search(pat: str, text: str):
    return re.search(pat, text, re.I)


def score_job(title: str, description: str, company: str = "", cfg: dict | None = None) -> dict:
    cfg = cfg or load_config()
    title = title or ""
    text = f"{title} {description or ''}"
    reasons: list[str] = []
    outreach: list[str] = []

    # --- hard disqualifiers ---
    for name, pat in cfg["hard_disqualifiers"].items():
        if _search(pat, text):
            return _out(0, "disqualified", [f"hard: {name}"], title, cfg, outreach)
    if _search(cfg["clinical_title_pattern"], title):
        return _out(0, "disqualified", ["hard: clinical/licensed role"], title, cfg, outreach)
    if _search(cfg["hospital_pattern"], company) or _search(cfg["big_org_pattern"], company):
        return _out(0, "disqualified", ["hard: hospital / large org - not small/mid ICP"], title, cfg, outreach)

    # --- senior/leadership title: strong penalty + hard cap (a buyer, not a fillable VA seat) ---
    senior = bool(_search(cfg["senior_title_pattern"], title))

    score = cfg["start_score"]
    for pat, pen in cfg["red_flags"].items():
        m = _search(pat, text)
        if m:
            score -= pen
            reasons.append(f"-{pen} {m.group(0)[:40].strip().lower()}")

    for pat, bonus in cfg["green_flags"].items():
        m = _search(pat, text)
        if m:
            score += bonus
            reasons.append(f"+{bonus} {m.group(0)[:40].strip().lower()}")

    # --- US-cert deprioritize (hard for an offshore VA to fill) ---
    if _search(cfg["us_cert_pattern"], text):
        score -= cfg["us_cert_penalty"]
        score = min(score, cfg["us_cert_cap"])
        reasons.append(f"-{cfg['us_cert_penalty']} US-cert required (hard to fill) -> cap {cfg['us_cert_cap']}")

    # --- intermediary / staffing company deprioritize ---
    if _search(cfg["intermediary_pattern"], f"{company} {title}"):
        score = min(score, cfg["intermediary_cap"])
        reasons.append(f"cap {cfg['intermediary_cap']}: staffing/intermediary poster")

    # --- senior title cap + penalty ---
    if senior:
        score -= cfg["senior_title_penalty"]
        score = min(score, cfg["senior_title_cap"])
        reasons.append(f"-{cfg['senior_title_penalty']} senior/leadership title -> cap {cfg['senior_title_cap']}")

    # --- weak medical context ---
    if not _search(cfg["medical_context_pattern"], title) and not _search(cfg["medical_context_pattern"], company):
        score = min(score, cfg["weak_medical_cap"])
        reasons.append(f"cap {cfg['weak_medical_cap']}: weak medical context")

    # --- remote signal ---
    remote = bool(_search(r"\bremote\b|work from home|wfh|telecommute|virtual|anywhere", text))
    onsite = bool(_search(r"on-?site|in-?office\b|in person\b", text))
    remote_signal = "explicit-remote" if remote and not onsite else ("on-site" if onsite else "ambiguous")

    score = max(0, min(100, score))
    if remote_signal == "ambiguous":
        score = min(score, cfg["ambiguous_remote_cap"])

    # --- outreach flags (do NOT affect score; drive sequence angle) ---
    for name, pat in cfg["outreach_flags"].items():
        if _search(pat, text):
            outreach.append(name)

    g = cfg["gate"]
    verdict = "qualified" if score >= g["qualified"] else ("nurture" if score >= g["nurture"] else "disqualified")
    return _out(score, verdict, reasons, title, cfg, outreach, remote_signal)


def _cluster(title: str, cfg: dict) -> str:
    for name, pat in cfg["title_clusters"].items():
        if _search(pat, title):
            return name
    return "general_va"


def _out(score, verdict, reasons, title, cfg, outreach, remote_signal="n/a") -> dict:
    return {
        "score": score, "verdict": verdict, "reasons": reasons,
        "title_cluster": _cluster(title, cfg), "outreach_flags": outreach,
        "remote_signal": remote_signal,
    }


if __name__ == "__main__":
    cfg = load_config()
    for t, d, c in [
        ("Remote Medical Biller", "verify insurance, billing, claims, remote", "Scion Staffing"),
        ("Sr. Reimbursement Specialist", "revenue cycle, must be authorized to work in the US", "United Biosource"),
        ("Medical Receptionist", "answer phones, schedule appointments, remote, EHR", "Small Family Practice"),
    ]:
        print(t, "->", score_job(t, d, c, cfg))
