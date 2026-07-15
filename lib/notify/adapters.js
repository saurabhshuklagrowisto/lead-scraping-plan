// Pluggable SDR notification layer. One notify() call, works across chat platforms —
// swap NOTIFY_CHANNEL and its webhook URL and nothing else in the codebase changes.
// Slack is the confirmed platform (see slackAdapter, uses Block Kit for clickable,
// readable alerts); Cliq/generic webhook stay as fallback adapters in case that changes.

function slackAdapter(webhookUrl) {
  return async (event) => {
    const body = { text: formatText(event), blocks: formatBlocks(event) };
    const res = await fetch(webhookUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("[notify:slack] webhook failed", res.status, await res.text());
  };
}

function formatBlocks(event) {
  const appUrl = event.appUrl || "";
  if (event.type === "hot_lead") {
    return [
      { type: "section", text: { type: "mrkdwn",
        text: `🔥 *Priority account:* ${event.company}\n${event.roleCount} open roles${event.score != null ? ` · score ${event.score}` : ""} — one conversation could close multiple placements.` } },
      appUrl ? { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in CRM" }, url: `${appUrl}#crm` }] } : null,
    ].filter(Boolean);
  }
  if (event.type === "reply") {
    return [{ type: "section", text: { type: "mrkdwn",
      text: `💬 *Reply from ${event.company}* (${event.title})\nHanded to CRM — check the Outreach tab.` } }];
  }
  if (event.type === "eval_result") {
    const icon = event.decision === "promote" ? "✅" : "⏸";
    return [{ type: "section", text: { type: "mrkdwn",
      text: `📊 *Weekly eval:* ${icon} ${event.decision === "promote" ? "promoted" : "held"} — agreement ${event.agreementPct}% (target 90%).` } }];
  }
  if (event.type === "budget_alert") {
    return [{ type: "section", text: { type: "mrkdwn",
      text: `💸 *Enrichment budget:* $${event.spentWeek.toFixed(2)} of $${event.weeklyCapUsd}/week spent — ${event.remaining} lead(s) queued for next cycle.` } }];
  }
  return [{ type: "section", text: { type: "mrkdwn", text: formatText(event) } }];
}

function zohoCliqAdapter(webhookUrl) {
  // Zoho Cliq incoming webhooks accept the same {text} shape as Slack.
  return async (event) => {
    const text = formatText(event);
    await fetch(webhookUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  };
}

function genericWebhookAdapter(webhookUrl) {
  // For WhatsApp (via Twilio/Meta Cloud API relay), Teams, or any custom receiver —
  // sends the raw event so the receiving side decides how to render it.
  return async (event) => {
    await fetch(webhookUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  };
}

function formatText(event) {
  switch (event.type) {
    case "hot_lead":
      return `🔥 Priority account: *${event.company}* — ${event.roleCount} open roles, score ${event.score}. ${event.url || ""}`;
    case "reply":
      return `💬 Reply from *${event.company}* (${event.title}). Handed to CRM — check the Outreach tab.`;
    case "eval_result":
      return `📊 Weekly eval: ${event.decision === "promote" ? "✅ promoted" : "⏸ held"} — agreement ${event.agreementPct}% (target 90%).`;
    case "budget_alert":
      return `💸 Enrichment budget: $${event.spentWeek.toFixed(2)} of $${event.weeklyCapUsd}/week spent — ${event.remaining} lead(s) queued for next cycle.`;
    default:
      return JSON.stringify(event);
  }
}

/**
 * getNotifier(env) -> async (event) => void
 * env.NOTIFY_WEBHOOK_URL: the Slack incoming-webhook URL (from Slack -> Incoming Webhooks -> Add New Webhook).
 * env.NOTIFY_CHANNEL: "slack" (default) | "cliq" | "webhook" — only needed if the platform ever changes.
 * env.APP_URL: the deployed dashboard URL, used to build the "Open in CRM" button.
 * If NOTIFY_WEBHOOK_URL is unset, falls back to a console-log no-op (safe default, no error).
 */
export function getNotifier(env) {
  const channel = env.NOTIFY_CHANNEL || "slack";
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) {
    return async (event) => console.log("[notify:noop, set NOTIFY_WEBHOOK_URL to enable]", JSON.stringify(event));
  }
  if (channel === "cliq") return zohoCliqAdapter(url);
  if (channel === "webhook") return genericWebhookAdapter(url);
  return slackAdapter(url);
}
