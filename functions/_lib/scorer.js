// JS port of pipeline/score.py — kept logically identical so the eval route and the
// Python scraper always agree on a score for the same rubric.config.json input.
// If you change scoring logic, change BOTH files and re-run the eval to confirm parity.

function search(pattern, text) {
  try { return new RegExp(pattern, "i").exec(text || ""); } catch { return null; }
}

export function scoreJob(title, description, company = "", cfg) {
  title = title || "";
  const text = `${title} ${description || ""}`;
  const reasons = [];
  const outreach = [];

  for (const [name, pat] of Object.entries(cfg.hard_disqualifiers)) {
    if (search(pat, text)) return out(0, "disqualified", [`hard: ${name}`], title, cfg, outreach);
  }
  if (search(cfg.clinical_title_pattern, title)) return out(0, "disqualified", ["hard: clinical/licensed role"], title, cfg, outreach);
  if (search(cfg.hospital_pattern, company) || search(cfg.big_org_pattern, company))
    return out(0, "disqualified", ["hard: hospital / large org - not small/mid ICP"], title, cfg, outreach);

  const senior = !!search(cfg.senior_title_pattern, title);
  let score = cfg.start_score;

  for (const [pat, pen] of Object.entries(cfg.red_flags)) {
    const m = search(pat, text);
    if (m) { score -= pen; reasons.push(`-${pen} ${m[0].slice(0, 40).trim().toLowerCase()}`); }
  }
  for (const [pat, bonus] of Object.entries(cfg.green_flags)) {
    const m = search(pat, text);
    if (m) { score += bonus; reasons.push(`+${bonus} ${m[0].slice(0, 40).trim().toLowerCase()}`); }
  }
  if (search(cfg.us_cert_pattern, text)) {
    score -= cfg.us_cert_penalty;
    score = Math.min(score, cfg.us_cert_cap);
    reasons.push(`-${cfg.us_cert_penalty} US-cert required -> cap ${cfg.us_cert_cap}`);
  }
  if (search(cfg.intermediary_pattern, `${company} ${title}`)) {
    score = Math.min(score, cfg.intermediary_cap);
    reasons.push(`cap ${cfg.intermediary_cap}: staffing/intermediary poster`);
  }
  if (senior) {
    score -= cfg.senior_title_penalty;
    score = Math.min(score, cfg.senior_title_cap);
    reasons.push(`-${cfg.senior_title_penalty} senior/leadership title -> cap ${cfg.senior_title_cap}`);
  }
  if (!search(cfg.medical_context_pattern, title) && !search(cfg.medical_context_pattern, company)) {
    score = Math.min(score, cfg.weak_medical_cap);
    reasons.push(`cap ${cfg.weak_medical_cap}: weak medical context`);
  }

  const remote = !!search("\\bremote\\b|work from home|wfh|telecommute|virtual|anywhere", text);
  const onsite = !!search("on-?site|in-?office\\b|in person\\b", text);
  const remoteSignal = remote && !onsite ? "explicit-remote" : onsite ? "on-site" : "ambiguous";

  score = Math.max(0, Math.min(100, score));
  if (remoteSignal === "ambiguous") score = Math.min(score, cfg.ambiguous_remote_cap);

  for (const [name, pat] of Object.entries(cfg.outreach_flags)) {
    if (search(pat, text)) outreach.push(name);
  }

  const g = cfg.gate;
  const verdict = score >= g.qualified ? "qualified" : score >= g.nurture ? "nurture" : "disqualified";
  return out(score, verdict, reasons, title, cfg, outreach, remoteSignal);
}

function cluster(title, cfg) {
  for (const [name, pat] of Object.entries(cfg.title_clusters)) {
    if (search(pat, title)) return name;
  }
  return "general_va";
}

function out(score, verdict, reasons, title, cfg, outreach, remoteSignal = "n/a") {
  return { score, verdict, reasons, title_cluster: cluster(title, cfg), outreach_flags: outreach, remote_signal: remoteSignal };
}
