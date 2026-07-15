// Pluggable SDR notification layer. One notify() call, works across chat platforms —
// swap NOTIFY_CHANNEL and its webhook URL and nothing else in the codebase changes.
// Chat platform not yet confirmed by the founders; ships with 3 adapters ready to go.

function slackAdapter(webhookUrl) {
  return async (event) => {
    const text = formatText(event);
    await fetch(webhookUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  };
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
    default:
      return JSON.stringify(event);
  }
}

/**
 * getNotifier(env) -> async (event) => void
 * env.NOTIFY_CHANNEL: "slack" | "cliq" | "webhook" | unset (no-op, logs only)
 * env.NOTIFY_WEBHOOK_URL: the incoming-webhook URL for whichever channel is chosen
 */
export function getNotifier(env) {
  const channel = env.NOTIFY_CHANNEL;
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!channel || !url) {
    return async (event) => console.log("[notify:noop]", JSON.stringify(event));
  }
  if (channel === "slack") return slackAdapter(url);
  if (channel === "cliq") return zohoCliqAdapter(url);
  return genericWebhookAdapter(url);
}
