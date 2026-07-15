// Cleanlist.ai client — real API, per https://docs.cleanlist.ai/mcp-api/*
// Auth: Authorization: Bearer clapi_... (env.CLEANLIST_API_KEY)
// Company enrichment is synchronous (1 credit); person enrichment is async and
// delivers results via webhook to /api/webhooks/enrichment (see that file for
// the workflow_id verification this depends on, since Cleanlist doesn't sign payloads).

const BASE = "https://api.cleanlist.ai";

function headers(env) {
  if (!env.CLEANLIST_API_KEY) throw new Error("CLEANLIST_API_KEY not set in Cloudflare Pages environment variables");
  return { Authorization: `Bearer ${env.CLEANLIST_API_KEY}`, "content-type": "application/json" };
}

/** Sync company lookup — confirms domain/size/industry for 1 credit. Use this before
 * spending more on person enrichment, same "free-gate-first" principle as NPPES. */
export async function enrichCompany(env, { domain, companyName }) {
  const res = await fetch(`${BASE}/enrichment/company`, {
    method: "POST", headers: headers(env),
    body: JSON.stringify({ domain, company_name: companyName }),
  });
  if (!res.ok) throw new Error(`Cleanlist company enrichment failed: ${res.status} ${await res.text()}`);
  return res.json(); // { company: {...}, credits_charged, timestamp_ms }
}

/** Async person lookup for a decision-maker contact. Cleanlist calls webhookUrl when done —
 * caller MUST record the returned workflow_id (with the company_id it belongs to) so the
 * webhook handler can verify it before writing a contact. */
export async function enrichPerson(env, { firstName, lastName, companyName, domain, email, linkedinUrl, enrichmentType = "full" }, webhookUrl) {
  const body = {
    lead_list_id: "default",
    enrichment_type: enrichmentType,
    webhook_url: webhookUrl,
  };
  if (email) body.email = email;
  else if (linkedinUrl) body.linkedin_url = linkedinUrl;
  else { body.first_name = firstName; body.last_name = lastName; body.company_name = companyName; body.domain = domain; }

  const res = await fetch(`${BASE}/enrichment/person`, { method: "POST", headers: headers(env), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Cleanlist person enrichment failed: ${res.status} ${await res.text()}`);
  return res.json(); // { workflow_id, status, credits_reserved, poll_url, timestamp_ms }
}

/** Fallback if a webhook is missed — poll directly. */
export async function pollStatus(env, workflowId) {
  const res = await fetch(`${BASE}/enrichment/status/${workflowId}`, { headers: headers(env) });
  if (!res.ok) throw new Error(`Cleanlist status poll failed: ${res.status} ${await res.text()}`);
  return res.json();
}
