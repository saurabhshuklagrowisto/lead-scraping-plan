// GET /api/pipeline-status — real funnel counts + integration health, straight from Supabase.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";

export async function onRequestGet({ env }) {
  try {
    const supabase = getSupabase(env);
    const counts = {};
    for (const v of ["qualified", "nurture", "disqualified"]) {
      const { count } = await supabase.from("job_postings").select("id", { count: "exact", head: true }).eq("current_verdict", v);
      counts[v] = count || 0;
    }
    const { count: total } = await supabase.from("job_postings").select("id", { count: "exact", head: true });
    const { data: integrations } = await supabase.from("integrations").select("name, status, mode, credential_present, last_ok_at");

    return json({ scraped: total || 0, ...counts, integrations, mode: "LIVE" });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
