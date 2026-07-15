// GET /api/leads?verdict=qualified&limit=50 — list scored postings from the real database.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";

export async function onRequestGet({ request, env }) {
  try {
    const supabase = getSupabase(env);
    const url = new URL(request.url);
    const verdict = url.searchParams.get("verdict");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 500);

    let q = supabase
      .from("job_postings")
      .select("id, title, title_cluster, current_score, current_verdict, remote_signal, lead_state, companies(name, location, priority_account, size_band)")
      .order("current_score", { ascending: false })
      .limit(limit);
    if (verdict) q = q.eq("current_verdict", verdict);

    const { data, error } = await q;
    if (error) return errorJson(error.message, 500);
    return json({ leads: data, count: data.length });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
