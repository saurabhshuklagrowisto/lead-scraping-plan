// POST /api/enrich-queue — cron-triggered, once a week. Spends the weekly $5 budget on the
// HIGHEST-SCORED unenriched companies first, then stops the moment the governor says no —
// the rest queue automatically for next week (nothing here bypasses enrich-lead's own checks,
// this just calls it in priority order instead of the dashboard calling it ad-hoc).
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { getNotifier } from "../../lib/notify/adapters.js";

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || auth !== env.CRON_SECRET) return errorJson("unauthorized", 401);
  try {
    const supabase = getSupabase(env);

    const { data: candidates, error } = await supabase
      .from("companies")
      .select("id, name, current_score, is_excluded, suppressed")
      .eq("is_excluded", false)
      .eq("suppressed", false)
      .is("cleanlist_checked_at", null)
      .order("current_score", { ascending: false })
      .limit(50);
    if (error) return errorJson(error.message, 500);

    const results = [];
    for (const c of candidates || []) {
      const res = await fetch(`${env.APP_URL}/api/enrich-lead`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company_id: c.id }),
      });
      const body = await res.json();
      results.push({ company: c.name, score: c.current_score, ...body });
      if (body.skipped && /budget/.test(body.reason || "")) {
        const spentMatch = /\$([\d.]+) spent this week of \$([\d.]+)/.exec(body.reason);
        await getNotifier(env)({
          type: "budget_alert",
          spentWeek: spentMatch ? Number(spentMatch[1]) : 0,
          weeklyCapUsd: spentMatch ? Number(spentMatch[2]) : Number(env.WEEKLY_SPEND_CAP_USD || 5),
          remaining: (candidates || []).length - results.length,
        });
        break; // cap hit — stop, rest wait for next week
      }
    }

    return json({ ok: true, processed: results.length, results });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
