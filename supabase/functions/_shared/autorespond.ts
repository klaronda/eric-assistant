// Shared auto-responder logic used by the Quo and Slack webhooks.
// Sends at most one courteous acknowledgment per person per cooldown window,
// paraphrasing their request and inviting an URGENT escalation. Also detects
// when someone replies "URGENT" and bumps their open task to the top.
//
// Everything here is best-effort: callers should wrap in try/catch so that a
// failure to auto-respond never breaks message ingestion.

import { createClient } from "jsr:@supabase/supabase-js@2";

type Supabase = ReturnType<typeof createClient>;

export type Preset =
  | "on_location"
  | "client_meetings"
  | "deep_work"
  | "ooo"
  | "custom";

type Settings = {
  enabled: boolean;
  preset: Preset;
  custom_message: string | null;
  respond_quo: boolean;
  respond_slack: boolean;
  cooldown_hours: number;
};

// Status phrase injected into every preset. Keep in sync with the frontend copy
// in web/src/lib/autoresponder.ts.
const PRESET_STATUS: Record<Exclude<Preset, "custom">, string> = {
  on_location: "directing an event on location",
  client_meetings: "in client strategy meetings",
  deep_work: "in a focused work block",
  ooo: "out of the office",
};

const PARAPHRASE_TOKEN = "[paraphrase request]";

function buildMessage(
  settings: Settings,
  paraphrase: string,
): string {
  if (settings.preset === "custom") {
    const custom = (settings.custom_message ?? "").trim();
    const base = custom ||
      `Hi, this is Eric's AI assistant — Eric is unavailable right now. Noted: ${PARAPHRASE_TOKEN}. He'll follow up soon; reply URGENT if it can't wait.`;
    return base.replaceAll(PARAPHRASE_TOKEN, paraphrase);
  }

  const status = PRESET_STATUS[settings.preset];
  const closing = settings.preset === "ooo"
    ? "He'll follow up on his return; reply URGENT if it can't wait."
    : "He'll follow up soon; reply URGENT if it can't wait.";
  return `Hi, this is Eric's AI assistant — Eric is ${status}. Noted: ${paraphrase}. ${closing}`;
}

export type AutoRespondContext = {
  channel: "quo" | "slack";
  contactId: string | null;
  inboundMessageId: string | null;
  sender: string; // their phone (quo) or slack user id
  recipient: string | null; // Eric's OpenPhone number (quo) or slack channel id
  threadId: string | null;
  body: string;
};

export async function maybeAutoRespond(
  supabase: Supabase,
  ctx: AutoRespondContext,
): Promise<Record<string, unknown>> {
  if (!ctx.contactId) return { skipped: "no_contact" };

  // 1) URGENT escalation — runs even when auto-reply is disabled, as long as we
  //    previously auto-replied to this person (so they were invited to escalate).
  if (/\burgent\b/i.test(ctx.body)) {
    const bumped = await bumpIfEscalated(supabase, ctx);
    if (bumped) return { urgent_bumped: true };
  }

  const settings = await loadSettings(supabase);
  if (!settings || !settings.enabled) return { skipped: "disabled" };
  if (ctx.channel === "quo" && !settings.respond_quo) {
    return { skipped: "quo_off" };
  }
  if (ctx.channel === "slack" && !settings.respond_slack) {
    return { skipped: "slack_off" };
  }

  // Slack: only auto-respond in direct messages (channel id starts with "D").
  if (ctx.channel === "slack" && !(ctx.recipient ?? "").startsWith("D")) {
    return { skipped: "not_dm" };
  }

  // Don't auto-respond to contacts marked as dump/spam.
  const { data: contact } = await supabase
    .from("contacts")
    .select("tag")
    .eq("id", ctx.contactId)
    .maybeSingle();
  if ((contact as { tag?: string } | null)?.tag === "dump") {
    return { skipped: "dump_contact" };
  }

  // Once-per-person cooldown.
  const cooldownMs = Math.max(0, settings.cooldown_hours) * 3600_000;
  if (cooldownMs > 0) {
    const since = new Date(Date.now() - cooldownMs).toISOString();
    const { data: recent } = await supabase
      .from("auto_responses")
      .select("id")
      .eq("contact_id", ctx.contactId)
      .eq("channel", ctx.channel)
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return { skipped: "cooldown" };
  }

  const paraphrase = await paraphraseRequest(ctx.body);
  const message = buildMessage(settings, paraphrase);

  // Send it.
  let sendOk = false;
  let sendError: string | null = null;
  try {
    if (ctx.channel === "quo") {
      if (!ctx.recipient) throw new Error("missing OpenPhone number to send from");
      await sendQuo(ctx.recipient, ctx.sender, message);
    } else {
      if (!ctx.recipient) throw new Error("missing Slack channel to send to");
      await sendSlack(ctx.recipient, message);
    }
    sendOk = true;
  } catch (e) {
    sendError = e instanceof Error ? e.message : String(e);
    console.error("auto-respond send failed", ctx.channel, sendError);
    return { skipped: "send_failed", error: sendError };
  }

  // Record the outbound message + log so it shows in threads and enforces cooldown.
  let replyMessageId: string | null = null;
  if (sendOk) {
    const { data: outbound } = await supabase
      .from("messages")
      .insert({
        channel: ctx.channel,
        direction: "outbound",
        contact_id: ctx.contactId,
        external_thread_id: ctx.threadId,
        from_identity: ctx.channel === "quo" ? ctx.recipient : "assistant",
        to_identity: ctx.channel === "quo" ? ctx.sender : ctx.recipient,
        body: message,
        raw: { auto_responder: true, preset: settings.preset },
        received_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    replyMessageId = (outbound as { id?: string } | null)?.id ?? null;

    await supabase.from("auto_responses").insert({
      contact_id: ctx.contactId,
      channel: ctx.channel,
      preset: settings.preset,
      inbound_message_id: ctx.inboundMessageId,
      reply_message_id: replyMessageId,
      body: message,
    });
  }

  return { auto_responded: true, preset: settings.preset, replyMessageId };
}

async function loadSettings(supabase: Supabase): Promise<Settings | null> {
  const { data } = await supabase
    .from("autoresponder_settings")
    .select("enabled, preset, custom_message, respond_quo, respond_slack, cooldown_hours")
    .eq("id", true)
    .maybeSingle();
  return (data as Settings | null) ?? null;
}

// Bump the contact's most recent open task when they reply URGENT after we
// auto-responded. Returns true if a bump happened.
async function bumpIfEscalated(
  supabase: Supabase,
  ctx: AutoRespondContext,
): Promise<boolean> {
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: priorReply } = await supabase
    .from("auto_responses")
    .select("id")
    .eq("contact_id", ctx.contactId)
    .eq("channel", ctx.channel)
    .gte("created_at", since)
    .limit(1);
  if (!priorReply || priorReply.length === 0) return false;

  const { data: task } = await supabase
    .from("tasks")
    .select("id")
    .eq("contact_id", ctx.contactId)
    .in("status", ["open", "snoozed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const taskId = (task as { id?: string } | null)?.id;
  if (!taskId) return false;

  await supabase
    .from("tasks")
    .update({
      urgency: 10,
      urgency_source: "sender",
      category: "needs_reply",
      status: "open",
      snooze_until: null,
      position: -1000,
    })
    .eq("id", taskId);
  return true;
}

async function paraphraseRequest(body: string): Promise<string> {
  const cleaned = body.replace(/\s+/g, " ").trim();
  const fallback = "your message";
  if (!cleaned) return fallback;

  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPEN_AI_SECRET");
  if (!apiKey) {
    // No AI available — use a short trimmed echo.
    return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 30,
        messages: [
          {
            role: "system",
            content:
              "Paraphrase the user's incoming message into a very short noun phrase " +
              "describing what they want (max 8 words), suitable to drop into the sentence " +
              "\"Noted: ___.\" No quotes, no trailing period. If unclear, respond with: your message.",
          },
          { role: "user", content: cleaned.slice(0, 800) },
        ],
      }),
    });
    if (!resp.ok) return fallback;
    const data = await resp.json();
    const text = String(data.choices?.[0]?.message?.content ?? "").trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\.$/, "");
    return text || fallback;
  } catch (e) {
    console.error("paraphrase failed", e);
    return fallback;
  }
}

async function sendQuo(from: string, to: string, content: string): Promise<void> {
  const apiKey = Deno.env.get("QUO_API_KEY") ?? Deno.env.get("OPENPHONE_API_KEY");
  if (!apiKey) throw new Error("QUO_API_KEY / OPENPHONE_API_KEY not set");
  const base = Deno.env.get("QUO_API_BASE")?.trim() || "https://api.openphone.com";

  const resp = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, from, to: [to] }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`quo send ${resp.status}: ${text.slice(0, 300)}`);
  }
}

async function sendSlack(channel: string, text: string): Promise<void> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`slack send failed: ${String(data.error ?? "unknown")}`);
  }
}
