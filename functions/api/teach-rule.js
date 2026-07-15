// POST /api/teach-rule — { text } plain-English rule from a founder.
// Stores as a CANDIDATE learned_rule. It does NOT affect scoring until a maintainer
// compiles it into a new scoring_version and that version passes /api/eval-run.
import { getSupabase, json, errorJson } from "../_lib/supabase.js";

export async function onRequestPost({ request, env }) {
  try {
    const { text } = await request.json();
    if (!text || text.trim().length < 5) return errorJson("text is required", 400);
    const supabase = getSupabase(env);

    const { data, error } = await supabase.from("learned_rules").insert({
      rule_text: text.trim(),
      rule_type: "candidate", // maintainer classifies into disqualifier/red_flag/green_flag/cap on review
      status: "candidate",
      confidence: 0.5,
    }).select().single();
    if (error) return errorJson(error.message, 500);

    return json({ ok: true, rule: data, note: "Saved as a candidate rule. It must be reviewed, compiled into a scoring_version, and pass the eval gate before it can affect real scores." });
  } catch (e) {
    return errorJson(e.message, 500);
  }
}
