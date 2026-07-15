// POST /api/enrich-email — { contact_id } — the MANUAL button action.
// Only callable on a contact that already exists (i.e. already has a name/LinkedIn
// from the automatic phone_only lookup). Fetches email only (1 credit, 'partial'),
// and UPDATES that same contact row rather than creating a duplicate.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { enrichPerson } from "../../lib/integrations/cleanlist.js";

export async function onRequestPost({ request, env }) {
  try {
    const { contact_id } = await request.json();
    if (!contact_id) return errorJson("contact_id is required", 400);
    const supabase = getSupabase(env);

    const { data: contact, error } = await supabase.from("contacts").select("*, companies(name, domain)").eq("id", contact_id).single();
    if (error || !contact) return errorJson("contact not found", 404);
    if (contact.email) return json({ ok: true, skipped: true, reason: "this contact already has an email on file — no credit spent" });

    const webhookUrl = `${env.APP_URL}/api/webhooks/enrichment`;
    const params = contact.linkedin_url
      ? { linkedinUrl: contact.linkedin_url, enrichmentType: "partial" }
      : { firstName: (contact.name || "").split(" ")[0], lastName: (contact.name || "").split(" ").slice(1).join(" "),
          companyName: contact.companies?.name, domain: contact.companies?.domain, enrichmentType: "partial" };

    const enrichRes = await enrichPerson(env, params, webhookUrl);

    await supabase.from("enrichment_requests").insert({
      workflow_id: enrichRes.workflow_id,
      company_id: contact.company_id,
      contact_query: { mode: "manual_email", contact_id },
      status: "pending",
    });

    return json({ ok: true, workflow_id: enrichRes.workflow_id, estimated_credits: 1, note: "Email lookup submitted (1 credit) — will update this contact when Cleanlist's webhook completes." });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
