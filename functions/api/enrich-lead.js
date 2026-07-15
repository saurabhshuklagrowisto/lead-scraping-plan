// POST /api/enrich-lead — { company_id } for a qualified/priority account.
//
// COST CONTROLS (Cleanlist pricing: partial/email=1 credit, phone_only=10, full=11 —
// phone is 10x the cost of email, so it is not the default):
//   1. Free NPPES size gate must already have passed (company.is_excluded = false) —
//      never spend a Cleanlist credit on a company the free gate would have rejected.
//   2. Dedup cache — skip entirely if this company already has enriched contacts.
//   3. Contact cap by company size (matches the plan's matrix): 2 for solo/small, 3 for mid.
//      Never buy more contacts per company than we'd actually use.
//   4. Tiered depth: 'full' (email+phone, 11 credits) ONLY for priority accounts (3+ open
//      roles) — that's where a phone number can close multiple placements in one call.
//      Every other qualified lead gets 'partial' (email only, 1 credit) — an 11x saving
//      on the long tail, since a phone number for a single-role lead rarely gets used.
//   5. Company confirm (1 credit) still runs first, same free-gate-before-spend principle.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";
import { enrichCompany, enrichPerson } from "../../lib/integrations/cleanlist.js";

const CONTACT_CAP = { solo_small: 2, mid: 3, billing_rcm: 2, unknown: 1, large: 0 };

export async function onRequestPost({ request, env }) {
  try {
    const { company_id, force_full } = await request.json();
    if (!company_id) return errorJson("company_id is required", 400);
    const supabase = getSupabase(env);

    const { data: company, error: cErr } = await supabase.from("companies").select("*").eq("id", company_id).single();
    if (cErr || !company) return errorJson("company not found", 404);
    if (company.suppressed) return errorJson("company is suppressed, refusing to enrich", 409);

    // --- Cost control 1: the free NPPES gate must have already excluded large/ineligible orgs.
    if (company.is_excluded) {
      return errorJson(`company excluded by size gate (${company.exclusion_reason || "unknown reason"}) — refusing to spend a credit`, 409);
    }

    // --- Cost control 2: dedup cache — don't pay for the same company twice.
    const { count: existingContacts } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("company_id", company_id);
    const cap = CONTACT_CAP[company.size_band] ?? CONTACT_CAP.unknown;
    if ((existingContacts || 0) >= cap) {
      return json({ ok: true, skipped: true, reason: `already has ${existingContacts} contact(s), at the ${company.size_band} cap of ${cap} — no credits spent` });
    }

    // --- Company confirm, 1 credit, cheap sanity check before the bigger spend.
    const companyResult = await enrichCompany(env, { domain: company.domain, companyName: company.name });
    const mappedSize = companyResult.company?.employee_count_range ? mapSizeBand(companyResult.company.employee_count_range) : company.size_band;
    if (mappedSize === "large") {
      await supabase.from("companies").update({ is_excluded: true, exclusion_reason: "Cleanlist company lookup revealed large org size", size_band: "large" }).eq("id", company_id);
      return errorJson("Cleanlist confirms this is a large org — excluding, no person-lookup credit spent", 409);
    }
    if (mappedSize !== company.size_band) await supabase.from("companies").update({ size_band: mappedSize }).eq("id", company_id);

    // --- Cost control 4: tiered depth. 'full' only for priority accounts (3+ roles) or an explicit override.
    const enrichmentType = (company.priority_account || force_full) ? "full" : "partial";
    const estimatedCredits = 1 /* company check */ + (enrichmentType === "full" ? 11 : 1);

    const title = mappedSize === "mid" ? "Practice Administrator" : "Owner";
    const webhookUrl = `${env.APP_URL}/api/webhooks/enrichment`;
    const enrichRes = await enrichPerson(env, { companyName: company.name, domain: company.domain, enrichmentType }, webhookUrl);

    // Record the workflow_id BEFORE the webhook can fire, so it's verifiable (Cleanlist doesn't sign webhooks).
    await supabase.from("enrichment_requests").insert({
      workflow_id: enrichRes.workflow_id,
      company_id,
      contact_query: { title_wanted: title, domain: company.domain, company_name: company.name, enrichment_type: enrichmentType },
      status: "pending",
    });

    return json({
      ok: true, workflow_id: enrichRes.workflow_id, company: companyResult.company,
      enrichment_type: enrichmentType, estimated_credits: estimatedCredits,
      note: enrichmentType === "partial" ? "Email-only (1 credit) — priority accounts get phone too; this one doesn't qualify yet." : "Full depth (11 credits) — priority account, phone included.",
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
