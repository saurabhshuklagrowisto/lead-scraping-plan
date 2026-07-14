#!/usr/bin/env node
/**
 * QuickTeam Outbound — Claude MCP server.
 * Lets a founder run the pipeline by talking to Claude:
 *   list_leads, get_lead, pipeline_status, submit_feedback, teach_rule, run_eval, learning_status
 * Reads the repo's seed data; run_eval shells out to the Python eval harness.
 * All writes go to mcp/state.json (DRY-RUN — nothing sends or spends).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf-8"));
const csv = () => {
  const raw = fs.readFileSync(path.join(ROOT, "db/seed/scored_seed.csv"), "utf-8").trim().split("\n");
  const head = raw[0].split(",");
  return raw.slice(1).map(line => {
    // naive CSV (description may contain commas) — take first N-1 fields, rest = description
    const parts = line.split(",");
    const o = {}; head.forEach((h, i) => o[h] = parts[i]);
    return { id: o.id, score: +o.score, verdict: o.verdict, title: o.title, company: o.company, size: o.practice_size_guess };
  });
};
const STATE = path.join(ROOT, "mcp/state.json");
const state = () => (fs.existsSync(STATE) ? read("mcp/state.json") : { feedback: [], taught_rules: [] });
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const text = o => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const TOOLS = [
  { name: "pipeline_status", description: "Funnel counts + integration health for the QuickTeam outbound pipeline.", inputSchema: { type: "object", properties: {} } },
  { name: "list_leads", description: "List scored leads. Filter by verdict (qualified|deprioritized|disqualified) and limit.", inputSchema: { type: "object", properties: { verdict: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_lead", description: "Get one lead by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "submit_feedback", description: "Label a posting to teach the scorer. verdict: agree|too_high|too_low|wrong_disqualify.", inputSchema: { type: "object", properties: { id: { type: "string" }, verdict: { type: "string" }, reason_tags: { type: "array", items: { type: "string" } }, note: { type: "string" } }, required: ["id", "verdict"] } },
  { name: "teach_rule", description: "Add a rule in plain English (becomes a candidate rule, eval-gated before it goes active).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "run_eval", description: "Run the eval harness on the 61-entry human holdout. mode: baseline (old AI) or candidate (our scorer).", inputSchema: { type: "object", properties: { mode: { type: "string" } } } },
  { name: "learning_status", description: "Current active rubric version, learned rules, latest eval agreement, and feedback collected.", inputSchema: { type: "object", properties: {} } },
];

const server = new Server({ name: "quickteam-outbound", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  const leads = csv();
  if (name === "pipeline_status") {
    const by = v => leads.filter(l => l.verdict === v).length;
    return text({ scraped: leads.length, qualified: by("qualified"), nurture: by("deprioritized"), disqualified: by("disqualified"),
      integrations: { jobspy: "live", nppes: "live", anthropic: "stub", clay: "stub", cleanlist: "stub", salesblink: "stub", close: "stub" }, mode: "DRY-RUN" });
  }
  if (name === "list_leads") {
    let out = leads; if (a.verdict) out = out.filter(l => l.verdict === a.verdict);
    return text(out.slice(0, a.limit || 20));
  }
  if (name === "get_lead") return text(leads.find(l => l.id === a.id) || { error: "not found" });
  if (name === "submit_feedback") {
    const s = state(); s.feedback.push({ id: a.id, verdict: a.verdict, reason_tags: a.reason_tags || [], note: a.note || "", at: new Date().toISOString() }); writeState(s);
    return text({ ok: true, stored: s.feedback.length, note: "Will be used as few-shot calibration in the next learning run (not instant retrain)." });
  }
  if (name === "teach_rule") {
    const s = state(); s.taught_rules.push({ text: a.text, status: "candidate", at: new Date().toISOString() }); writeState(s);
    return text({ ok: true, status: "candidate", note: "Converted to a candidate rule. Must pass the eval gate on the 61 holdout before it can score real leads." });
  }
  if (name === "learning_status") {
    const cfg = read("lib/scoring/rubric.config.json"); const rules = read("db/seed/learned_rules.json").rules; const runs = read("db/seed/eval_runs.json").runs; const s = state();
    return text({ active_rubric: cfg.version, learned_rules: rules.length, active_rules: rules.filter(r => r.status === "active").length,
      latest_agreement_pct: runs.find(r => r.role === "candidate")?.agreement_pct, feedback_collected: s.feedback.length, taught_rules_pending: s.taught_rules.length });
  }
  if (name === "run_eval") {
    const args = ["lib/eval/eval_holdout.py"]; if ((a.mode || "candidate") === "baseline") args.push("--baseline");
    return await new Promise(res => execFile("python", args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
      (err, stdout, stderr) => res(text(err ? { error: String(err), stderr } : stdout))));
  }
  return text({ error: `unknown tool ${name}` });
});

await server.connect(new StdioServerTransport());
console.error("quickteam-outbound MCP server running (stdio)");
