// POST /api/webhooks/enrichment — Cleanlist (or Clay) calls back here with a resolved contact.
// Guarded by a shared secret header so only the enrichment provider can write contacts.
// Expected body: { company_id, name, title, linkedin_url, email, phone, source }
import { getSupabase, json, errorJson } from "../../_lib/supabase.js";

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get("x-webhook-secret");
  if (!env.ENRICHMENT_WEBHOOK_SECRET || auth !== env.ENRICHMENT_WEBHOOK_SECRET) {
    return errorJson("unauthorized", 401);
  }
  try {
    const body = await request.json();
    if (!body.company_id) return errorJson("company_id is required", 400);
    const supabase = getSupabase(env);

    const { data, error } = await supabase.from("contacts").insert({
      company_id: body.company_id,
      name: body.name || null,
      title: body.title || null,
      linkedin_url: body.linkedin_url || null,
      email: body.email || null,
      phone: body.phone || null,
      enriched_by: body.source || "cleanlist",
      email_verified_status: body.email_verified_status || "unverified",
    }).select().single();
    if (error) return errorJson(error.message, 500);

    return json({ ok: true, contact: data });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
