// POST /api/notify-hot-leads — call after a scrape run (or on a schedule) to alert SDRs
// about newly-scored priority accounts (3+ roles) they haven't been notified about yet.
// Guarded the same way as /api/eval-run (cron-only, not public).
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { getNotifier } from "../../lib/notify/adapters.js";

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || auth !== env.CRON_SECRET) return errorJson("unauthorized", 401);

  try {
    const supabase = getSupabase(env);
    const notify = getNotifier(env);

    const { data: hot, error } = await supabase
      .from("companies")
      .select("id, name, open_roles_count")
      .eq("priority_account", true)
      .eq("suppressed", false)
      .limit(20);
    if (error) return errorJson(error.message, 500);

    let sent = 0;
    for (const c of hot) {
      await notify({ type: "hot_lead", company: c.name, roleCount: c.open_roles_count, score: null, appUrl: env.APP_URL });
      sent++;
    }
    return json({ ok: true, notified: sent });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
