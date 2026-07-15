// POST /api/enrich-lead — { company_id } for a qualified/priority account.
// 1. Confirms company details via Cleanlist (sync, 1 credit) — same free-size-gate-first
//    principle as NPPES: cheap check before the more expensive contact lookup.
// 2. Submits an async person-enrichment request for the right decision-maker title
//    (owner for solo/small, practice admin/ops for mid-size — matches the plan's matrix).
// 3. Records the workflow_id in enrichment_requests BEFORE Cleanlist responds via webhook,
//    since /api/webhooks/enrichment must verify it against this table (Cleanlist doesn't
//    sign its webhook payloads).
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { enrichCompany, enrichPerson } from "../../lib/integrations/cleanlist.js";

export async function onRequestPost({ request, env }) {
  try {
    const { company_id } = await request.json();
    if (!company_id) return errorJson("company_id is required", 400);
    const supabase = getSupabase(env);

    const { data: company, error: cErr } = await supabase.from("companies").select("*").eq("id", company_id).single();
    if (cErr || !company) return errorJson("company not found", 404);
    if (company.suppressed) return errorJson("company is suppressed, refusing to enrich", 409);

    // Step 1: confirm company details for 1 credit
    const companyResult = await enrichCompany(env, { domain: company.domain, companyName: company.name });
    await supabase.from("companies").update({
      nppes_checked_at: company.nppes_checked_at, // unchanged, NPPES stays the size gate
      size_band: companyResult.company?.employee_count_range ? mapSizeBand(companyResult.company.employee_count_range) : company.size_band,
    }).eq("id", company_id);

    // Step 2: decision-maker title, matching the plan's matrix by size_band
    const title = company.size_band === "mid" ? "Practice Administrator" : "Owner";
    const webhookUrl = `${env.APP_URL}/api/webhooks/enrichment`;
    const enrichRes = await enrichPerson(env, { companyName: company.name, domain: company.domain, enrichmentType: "full" }, webhookUrl);

    // Step 3: record the workflow_id BEFORE the webhook can fire, so it's verifiable
    await supabase.from("enrichment_requests").insert({
      workflow_id: enrichRes.workflow_id,
      company_id,
      contact_query: { title_wanted: title, domain: company.domain, company_name: company.name },
      status: "pending",
    });

    return json({ ok: true, workflow_id: enrichRes.workflow_id, company: companyResult.company, status: "person_enrichment_submitted" });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}

function mapSizeBand(employeeRange) {
  // Cleanlist's employee_count_range is a free-text bucket (e.g. "1-10", "11-50") - map loosely.
  const n = parseInt((employeeRange || "").split("-")[0], 10);
  if (!n) return "unknown";
  if (n <= 10) return "solo_small";
  if (n <= 50) return "mid";
  return "large";
}
