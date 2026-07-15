// POST /api/webhooks/enrichment — Cleanlist's real callback shape (per docs.cleanlist.ai):
//   { event: "enrichment.completed", workflow_id, status, summary: {...}, results: [
//       { task_id, status, prospect_id, lead_id, result: { email, email_status, other_emails,
//         phones, linkedin_url, provider }, input: {...}, error? }
//   ], completed_at }
//
// SECURITY NOTE: Cleanlist does not sign webhook payloads (confirmed in their docs) — the
// only defense is checking workflow_id against a request WE actually submitted and recorded
// in enrichment_requests. Anything else is rejected. This is not optional.
import { getSupabase, json, errorJson } from "../../_lib/supabase.js";

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { workflow_id, results, status } = body;
    if (!workflow_id) return errorJson("missing workflow_id", 400);

    const supabase = getSupabase(env);

    // Verify: this workflow_id must be one we submitted ourselves.
    const { data: reqRow, error: findErr } = await supabase
      .from("enrichment_requests").select("*").eq("workflow_id", workflow_id).single();
    if (findErr || !reqRow) {
      // Do not process unknown workflow_ids — could be forged/replayed since there's no signature.
      return errorJson("unknown workflow_id, ignoring", 202);
    }
    if (reqRow.status !== "pending") {
      return json({ ok: true, note: "already processed, ignoring duplicate delivery" });
    }

    let written = 0;
    for (const r of results || []) {
      if (r.status !== "success" && r.error) continue;
      const c = r.result || {};
      await supabase.from("contacts").insert({
        company_id: reqRow.company_id,
        name: c.full_name || null,
        title: reqRow.contact_query?.title_wanted || null,
        linkedin_url: c.linkedin_url || null,
        email: c.email || null,
        email_verified_status: c.email_status || "unverified",
        phone: Array.isArray(c.phones) ? c.phones[0] : c.phone || null,
        enriched_by: c.provider || "cleanlist",
      });
      written++;
    }

    await supabase.from("enrichment_requests").update({
      status: status || "completed", completed_at: new Date().toISOString(),
    }).eq("workflow_id", workflow_id);

    return json({ ok: true, contacts_written: written });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
