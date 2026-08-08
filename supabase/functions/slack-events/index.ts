import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-slack-signature, x-slack-request-timestamp",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const rawBody = await req.text();

  const tokenError = checkIngestToken(req);
  if (tokenError) return json({ error: tokenError }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Must answer Slack's challenge before signature checks (secret typos block verify).
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const signingSecret = Deno.env.get("SLACK_SIGNING_SECRET")?.trim();
  if (signingSecret) {
    const ok = await verifySlackSignature(req, rawBody, signingSecret);
    if (!ok) {
      console.error("Invalid Slack signature", {
        hasTimestamp: Boolean(req.headers.get("x-slack-request-timestamp")),
        hasSignature: Boolean(req.headers.get("x-slack-signature")),
      });
      return json({ error: "Invalid Slack signature" }, 401);
    }
  } else {
    console.warn("SLACK_SIGNING_SECRET unset — accepting unverified events");
  }

  if (payload.type !== "event_callback") {
    return json({ ok: true, skipped: true, reason: `ignored ${payload.type}` });
  }

  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) return json({ ok: true, skipped: true, reason: "no event" });

  if (event.bot_id || event.subtype) {
    return json({ ok: true, skipped: true, reason: "bot or subtype" });
  }

  const eventType = String(event.type ?? "");
  if (eventType !== "message" && eventType !== "app_mention") {
    return json({ ok: true, skipped: true, reason: `ignored event ${eventType}` });
  }

  const text = String(event.text ?? "").trim();
  const userId = String(event.user ?? "");
  const channelId = String(event.channel ?? "");
  const ts = String(event.ts ?? "");
  const threadTs = event.thread_ts ? String(event.thread_ts) : ts;

  if (!userId || !ts) {
    return json({ ok: true, skipped: true, reason: "missing user/ts" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const contactId = await upsertContact(supabase, userId);
  const externalMessageId = `${channelId}:${ts}`;

  const { data: existingMessage } = await supabase
    .from("messages")
    .select("id")
    .eq("channel", "slack")
    .eq("external_message_id", externalMessageId)
    .maybeSingle();

  let messageId = existingMessage?.id as string | undefined;

  if (!messageId) {
    const receivedAt = slackTsToIso(ts);
    const { data: inserted, error: insertError } = await supabase
      .from("messages")
      .insert({
        channel: "slack",
        direction: "inbound",
        contact_id: contactId,
        external_message_id: externalMessageId,
        external_thread_id: `${channelId}:${threadTs}`,
        from_identity: userId,
        to_identity: channelId,
        body: text,
        raw: payload,
        received_at: receivedAt,
      })
      .select("id")
      .single();

    if (insertError) {
      const { data: raced } = await supabase
        .from("messages")
        .select("id")
        .eq("channel", "slack")
        .eq("external_message_id", externalMessageId)
        .maybeSingle();
      if (!raced?.id) {
        console.error("insert slack message failed", insertError);
        return json({ error: insertError.message }, 500);
      }
      messageId = raced.id;
    } else {
      messageId = inserted.id;
    }
  }

  let taskId: string | null = null;
  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("tag")
      .eq("id", contactId)
      .single();

    if (contact?.tag !== "dump") {
      const { data: existingTask } = await supabase
        .from("tasks")
        .select("id")
        .eq("source_message_id", messageId)
        .maybeSingle();

      if (existingTask?.id) {
        taskId = existingTask.id;
      } else {
        const title = makeTitle(text, userId);
        const { data: task, error: taskError } = await supabase
          .from("tasks")
          .insert({
            contact_id: contactId,
            source_message_id: messageId,
            channel: "slack",
            title,
            summary: text.slice(0, 500),
            urgency: eventType === "app_mention" ? 6 : 5,
            urgency_source: "channel",
            status: "open",
          })
          .select("id")
          .single();
        if (taskError) console.error("insert slack task failed", taskError);
        else taskId = task.id;
      }
    }
  }

  return json({ ok: true, messageId, contactId, taskId });
});

function checkIngestToken(req: Request): string | null {
  const ingestToken = Deno.env.get("SLACK_INGEST_TOKEN")?.trim();
  if (!ingestToken) return null;
  const url = new URL(req.url);
  const provided = url.searchParams.get("token") ??
    req.headers.get("x-eric-ingest-token");
  if (provided !== ingestToken) return "Invalid ingest token";
  return null;
}

async function verifySlackSignature(
  req: Request,
  rawBody: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = new TextEncoder().encode(signingSecret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(base),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `v0=${hex}`;

  if (expected.length !== signature.length) return false;
  let out = 0;
  for (let i = 0; i < expected.length; i++) {
    out |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return out === 0;
}

async function upsertContact(
  supabase: ReturnType<typeof createClient>,
  slackUserId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("contact_identities")
    .select("contact_id")
    .eq("channel", "slack")
    .eq("external_id", slackUserId)
    .maybeSingle();
  if (existing?.contact_id) return existing.contact_id;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      display_name: slackUserId,
      tag: "unknown",
    })
    .select("id")
    .single();
  if (contactError) {
    console.error("create slack contact failed", contactError);
    return null;
  }

  const { error: identityError } = await supabase.from("contact_identities").insert({
    contact_id: contact.id,
    channel: "slack",
    external_id: slackUserId,
    label: "slack_user",
  });
  if (identityError) {
    const { data: raced } = await supabase
      .from("contact_identities")
      .select("contact_id")
      .eq("channel", "slack")
      .eq("external_id", slackUserId)
      .maybeSingle();
    if (raced?.contact_id) return raced.contact_id;
    console.error("create slack identity failed", identityError);
  }
  return contact.id;
}

function slackTsToIso(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function makeTitle(body: string, from: string): string {
  const cleaned = body.replace(/<@[A-Z0-9]+>/g, "").trim().replace(/\s+/g, " ");
  if (!cleaned) return `Slack from ${from}`;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
