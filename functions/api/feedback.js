// POST /api/feedback — { job_posting_id, verdict, reason_tags?, corrected_score?, note?, annotator? }
// Writes a first-class feedback row (history preserved, never overwrites) and logs a lead_event.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";

const VALID_VERDICTS = ["agree", "too_high", "too_low", "wrong_disqualify", "wrong_qualify"];

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    if (!body.job_posting_id || !VALID_VERDICTS.includes(body.verdict)) {
      return errorJson(`job_posting_id and a valid verdict (${VALID_VERDICTS.join("|")}) are required`, 400);
    }
    const supabase = getSupabase(env);

    const { data, error } = await supabase.from("feedback").insert({
      job_posting_id: body.job_posting_id,
      annotator: body.annotator || "anonymous",
      verdict: body.verdict,
      corrected_score: body.corrected_score ?? null,
      reason_tags: body.reason_tags || [],
      note: body.note || null,
    }).select().single();
    if (error) return errorJson(error.message, 500);

    await supabase.from("lead_events").insert({
      job_posting_id: body.job_posting_id, from_state: null, to_state: "feedback_received", agent: "human",
    });

    return json({ ok: true, feedback: data, note: "Stored. Used as few-shot calibration in the next learning run — not an instant retrain." });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
