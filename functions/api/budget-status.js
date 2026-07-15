// GET /api/budget-status — how much of the $5/week, $20/month cap has been spent so far.
// Powers the dashboard's health panel; public read is fine, this exposes no secrets.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { canSpend } from "../_lib/budget.js";

export async function onRequestGet({ env }) {
  try {
    const supabase = getSupabase(env);
    const probe = await canSpend(supabase, env, "partial_email"); // cheapest purpose, just to read totals
    return json({
      ok: true,
      spent_week_usd: Number(probe.spentWeek.toFixed(2)),
      cap_week_usd: probe.weeklyCapUsd,
      spent_month_usd: Number(probe.spentMonth.toFixed(2)),
      cap_month_usd: probe.monthlyCapUsd,
    });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
