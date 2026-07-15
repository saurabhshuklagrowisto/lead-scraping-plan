// POST /api/enrich-lead — { company_id } — the AUTOMATIC path. Phone numbers only.
// Email is NOT fetched here — that's a separate manual action (see enrich-email.js),
// triggered by a button in the dashboard once a contact's name is known.
//
// COST CONTROLS (Cleanlist pricing: partial/email=1 credit, phone_only=10, full=11):
//   1. Free NPPES size gate must already have passed (company.is_excluded = false) —
//      never spend a Cleanlist credit on a company the free gate would have rejected.
//   2. Company confirm (1 credit) runs at most ONCE per company (cleanlist_checked_at),
//      never repeated on subsequent enrichment calls for the same company.
//   3. Dedup cache — skip entirely if this company already has enriched contacts.
//   4. Contact cap by company size (matches the plan's matrix): 2 for solo/small, 3 for mid.
//   5. Depth = 'phone_only' (10 credits) for every qualifying lead — email is deliberately
//      deferred to the manual button, since the auto process only needs mobile numbers.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { enrichCompany, enrichPerson } from "../../lib/integrations/cleanlist.js";

const CONTACT_CAP = { solo_small: 2, mid: 3, billing_rcm: 2, unknown: 1, large: 0 };

export async function onRequestPost({ request, env }) {
  try {
    const { company_id } = await request.json();
    if (!company_id) return errorJson("company_id is required", 400);
    const supabase = getSupabase(env);

    const { data: company, error: cErr } = await supabase.from("companies").select("*").eq("id", company_id).single();
    if (cErr || !company) return errorJson("company not found", 404);
    if (company.suppressed) return errorJson("company is suppressed, refusing to enrich", 409);

    // --- Cost control 1: the free NPPES gate must have already excluded large/ineligible orgs.
    if (company.is_excluded) {
      return errorJson(`company excluded by size gate (${company.exclusion_reason || "unknown reason"}) — refusing to spend a credit`, 409);
    }

    // --- Cost control 3: dedup cache — don't pay for the same company twice.
    const { count: existingContacts } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("company_id", company_id);
    const cap = CONTACT_CAP[company.size_band] ?? CONTACT_CAP.unknown;
    if ((existingContacts || 0) >= cap) {
      return json({ ok: true, skipped: true, reason: `already has ${existingContacts} contact(s), at the ${company.size_band} cap of ${cap} — no credits spent` });
    }

    // --- Cost control 2: company confirm only once per company, ever.
    let sizeBand = company.size_band;
    let companyResult = null;
    if (!company.cleanlist_checked_at) {
      companyResult = await enrichCompany(env, { domain: company.domain, companyName: company.name });
      sizeBand = companyResult.company?.employee_count_range ? mapSizeBand(companyResult.company.employee_count_range) : company.size_band;
      const patch = { cleanlist_checked_at: new Date().toISOString() };
      if (sizeBand !== company.size_band) patch.size_band = sizeBand;
      if (sizeBand === "large") { patch.is_excluded = true; patch.exclusion_reason = "Cleanlist company lookup revealed large org size"; }
      await supabase.from("companies").update(patch).eq("id", company_id);
      if (sizeBand === "large") return errorJson("Cleanlist confirms this is a large org — excluding, no person-lookup credit spent", 409);
    }

    // --- Cost control 5: phone only, auto path. Email is a separate manual action.
    const title = sizeBand === "mid" ? "Practice Administrator" : "Owner";
    const webhookUrl = `${env.APP_URL}/api/webhooks/enrichment`;
    const enrichRes = await enrichPerson(env, { companyName: company.name, domain: company.domain, enrichmentType: "phone_only" }, webhookUrl);

    // Record the workflow_id BEFORE the webhook can fire, so it's verifiable (Cleanlist doesn't sign webhooks).
    await supabase.from("enrichment_requests").insert({
      workflow_id: enrichRes.workflow_id,
      company_id,
      contact_query: { mode: "auto_phone", title_wanted: title, domain: company.domain, company_name: company.name },
      status: "pending",
    });

    return json({
      ok: true, workflow_id: enrichRes.workflow_id, enrichment_type: "phone_only",
      estimated_credits: companyResult ? 11 : 10,
      note: "Phone number only. Once the contact's name comes back, use /api/enrich-email (or the dashboard button) to add their email on demand.",
    });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}

function mapSizeBand(employeeRange) {
  const n = parseInt((employeeRange || "").split("-")[0], 10);
  if (!n) return "unknown";
  if (n <= 10) return "solo_small";
  if (n <= 50) return "mid";
  return "large";
}
