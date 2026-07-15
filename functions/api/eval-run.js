// POST /api/eval-run — runs the eval gate: scores the locked holdout with the active rubric,
// compares against the last promoted baseline, and writes an eval_runs row.
// This mirrors lib/eval/eval_holdout.py's logic in JS since Cloudflare Functions can't run Python.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { scoreJob } from "../_lib/scorer.js";

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || auth !== env.CRON_SECRET) {
    return errorJson("unauthorized", 401);
  }
  try {
    const supabase = getSupabase(env);

    const { data: activeVersion, error: vErr } = await supabase
      .from("scoring_versions").select("*").eq("status", "active").single();
    if (vErr) return errorJson("no active scoring_version found: " + vErr.message, 500);

    const { data: holdout, error: hErr } = await supabase
      .from("labeled_holdout")
      .select("gold_verdict, job_postings(title, description)")
      .eq("set_name", "v1_61");
    if (hErr) return errorJson(hErr.message, 500);

    const cfg = activeVersion.rubric_config;
    let agree = 0, falseDisqualify = 0;
    const perItem = [];
    for (const h of holdout) {
      const goldGood = h.gold_verdict === "qualified" || h.gold_verdict === "nurture";
      const res = scoreJob(h.job_postings?.title || "", h.job_postings?.description || "", "", cfg);
      const predGood = res.verdict === "qualified" || res.verdict === "nurture";
      if (predGood === goldGood) agree++;
      if (goldGood && !predGood) falseDisqualify++;
      perItem.push({ title: h.job_postings?.title, gold: h.gold_verdict, pred: res.verdict });
    }
    const n = holdout.length;
    const agreementPct = Math.round((agree / n) * 1000) / 10;
    const falseDisqualifyRate = Math.round((falseDisqualify / n) * 1000) / 10;

    const { data: run, error: rErr } = await supabase.from("eval_runs").insert({
      candidate_version_id: activeVersion.id,
      baseline_version_id: activeVersion.parent_version_id,
      holdout_set_id: "v1_61",
      agreement_pct: agreementPct,
      false_disqualify_rate: falseDisqualifyRate,
      n_labeled: n,
      decision: agreementPct >= 90 ? "promote" : "reject",
      per_item: perItem,
    }).select().single();
    if (rErr) return errorJson(rErr.message, 500);

    return json({ ok: true, agreement_pct: agreementPct, false_disqualify_rate: falseDisqualifyRate, n, decision: run.decision, run_id: run.id });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
