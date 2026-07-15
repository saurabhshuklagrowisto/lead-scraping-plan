// Hard cost ceiling on all Cleanlist spend: $5/week, $20/month (env-overridable).
// Cleanlist credit packs are a flat $0.10/credit (their published pricing) — see CREDIT_COST_USD.
// Every enrichment call MUST check remaining budget first via canSpend(), then record the
// actual spend via recordSpend() only after Cleanlist accepts the request. This keeps the
// governor honest even if a call fails after the credit was reserved.

export const CREDIT_COST_USD = 0.10;
export const CREDITS = { company_confirm: 1, phone_only: 10, partial_email: 1, full: 11 };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function canSpend(supabase, env, purpose) {
  const credits = CREDITS[purpose];
  const usd = credits * CREDIT_COST_USD;
  const weeklyCapUsd = Number(env.WEEKLY_SPEND_CAP_USD || 5);
  const monthlyCapUsd = Number(env.MONTHLY_SPEND_CAP_USD || 20);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();
  const monthAgo = new Date(now.getTime() - MONTH_MS).toISOString();

  const [{ data: weekRows }, { data: monthRows }] = await Promise.all([
    supabase.from("spend_ledger").select("usd").gte("created_at", weekAgo),
    supabase.from("spend_ledger").select("usd").gte("created_at", monthAgo),
  ]);
  const spentWeek = (weekRows || []).reduce((s, r) => s + Number(r.usd), 0);
  const spentMonth = (monthRows || []).reduce((s, r) => s + Number(r.usd), 0);

  const ok = spentWeek + usd <= weeklyCapUsd && spentMonth + usd <= monthlyCapUsd;
  return {
    ok, credits, usd,
    spentWeek, spentMonth, weeklyCapUsd, monthlyCapUsd,
    remainingWeek: Math.max(0, weeklyCapUsd - spentWeek),
    remainingMonth: Math.max(0, monthlyCapUsd - spentMonth),
    reason: ok ? null : (spentWeek + usd > weeklyCapUsd ? "weekly cap" : "monthly cap"),
  };
}

export async function recordSpend(supabase, { companyId, contactId, purpose }) {
  const credits = CREDITS[purpose];
  await supabase.from("spend_ledger").insert({
    company_id: companyId || null,
    contact_id: contactId || null,
    purpose,
    credits,
    usd: credits * CREDIT_COST_USD,
  });
}
