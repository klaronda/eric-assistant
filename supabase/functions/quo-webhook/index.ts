import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { maybeAutoRespond } from "../_shared/autorespond.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, webhook-id, webhook-timestamp, webhook-signature, openphone-signature",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  const authError = authorize(req);
  if (authError) return json({ error: authError }, 401);

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const eventType = String(envelope.type ?? "");
  if (eventType !== "message.received" && eventType !== "message.delivered") {
    return json({ ok: true, skipped: true, reason: `ignored type ${eventType}` });
  }

  const parsed = parseMessageEvent(envelope, eventType);
  if (!parsed) return json({ error: "Unrecognized message payload shape" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const contactId = await upsertContact(supabase, parsed.fromIdentity);

  const { data: existingMessage } = await supabase
    .from("messages")
    .select("id")
    .eq("channel", "quo")
    .eq("external_message_id", parsed.externalMessageId)
    .maybeSingle();

  let messageId = existingMessage?.id as string | undefined;

  if (!messageId) {
    const { data: inserted, error: insertError } = await supabase
      .from("messages")
      .insert({
        channel: "quo",
        direction: parsed.direction,
        contact_id: contactId,
        external_message_id: parsed.externalMessageId,
        external_thread_id: parsed.externalThreadId,
        from_identity: parsed.fromIdentity,
        to_identity: parsed.toIdentity,
        body: parsed.body,
        raw: envelope,
        received_at: parsed.receivedAt,
      })
      .select("id")
      .single();

    if (insertError) {
      const { data: raced } = await supabase
        .from("messages")
        .select("id")
        .eq("channel", "quo")
        .eq("external_message_id", parsed.externalMessageId)
        .maybeSingle();
      if (!raced?.id) {
        console.error("insert message failed", insertError);
        return json({ error: insertError.message }, 500);
      }
      messageId = raced.id;
    } else {
      messageId = inserted.id;
    }
  }

  let taskId: string | null = null;
  if (parsed.direction === "inbound" && contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("tag")
      .eq("id", contactId)
      .single();

    if (contact?.tag !== "dump") {
      const title = makeTitle(parsed.body, parsed.fromIdentity);
      const { data: existingTask } = await supabase
        .from("tasks")
        .select("id")
        .eq("source_message_id", messageId)
        .maybeSingle();

      if (existingTask?.id) {
        taskId = existingTask.id;
      } else {
        const { data: task, error: taskError } = await supabase
          .from("tasks")
          .insert({
            contact_id: contactId,
            source_message_id: messageId,
            channel: "quo",
            title,
            summary: parsed.body.slice(0, 500),
            urgency: 5,
            urgency_source: "channel",
            status: "open",
          })
          .select("id")
          .single();
        if (taskError) console.error("insert task failed", taskError);
        else taskId = task.id;
      }
    }
  }

  let autoResponse: Record<string, unknown> | undefined;
  if (parsed.direction === "inbound") {
    try {
      autoResponse = await maybeAutoRespond(supabase, {
        channel: "quo",
        contactId,
        inboundMessageId: messageId ?? null,
        sender: parsed.fromIdentity,
        recipient: parsed.toIdentity,
        threadId: parsed.externalThreadId,
        body: parsed.body,
      });
    } catch (e) {
      console.error("auto-respond error", e);
    }
  }

  return json({ ok: true, eventType, messageId, contactId, taskId, autoResponse });
});

function authorize(req: Request): string | null {
  const ingestToken = Deno.env.get("QUO_INGEST_TOKEN")?.trim();
  const url = new URL(req.url);
  const provided = url.searchParams.get("token") ??
    req.headers.get("x-eric-ingest-token");

  // Token-only auth for reliability. Quo signature formats vary; token in URL is enough.
  if (ingestToken && provided !== ingestToken) {
    return "Invalid ingest token";
  }
  if (!ingestToken) {
    console.warn("QUO_INGEST_TOKEN unset — accepting webhook (bootstrap)");
  }
  return null;
}

function parseMessageEvent(
  envelope: Record<string, unknown>,
  eventType: string,
): {
  direction: "inbound" | "outbound";
  externalMessageId: string;
  externalThreadId: string | null;
  fromIdentity: string;
  toIdentity: string | null;
  body: string;
  receivedAt: string;
} | null {
  const data = envelope.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const resource = data.resource as Record<string, unknown> | undefined;
  const context = data.context as Record<string, unknown> | undefined;
  if (resource && context) {
    const direction =
      resource.direction === "outgoing" || eventType === "message.delivered"
        ? "outbound"
        : "inbound";
    const sender = String(context.senderIdentifier ?? "");
    const recipients = context.recipientIdentifiers;
    const recipient = Array.isArray(recipients)
      ? String(recipients[0] ?? "")
      : "";
    return {
      direction,
      externalMessageId: String(resource.id ?? ""),
      externalThreadId: context.conversationId
        ? String(context.conversationId)
        : null,
      fromIdentity: sender || "unknown",
      toIdentity: recipient || null,
      body: String(resource.text ?? ""),
      receivedAt: String(resource.createdAt ?? new Date().toISOString()),
    };
  }

  const object = data.object as Record<string, unknown> | undefined;
  if (object) {
    const direction =
      object.direction === "outgoing" || eventType === "message.delivered"
        ? "outbound"
        : "inbound";
    return {
      direction,
      externalMessageId: String(object.id ?? ""),
      externalThreadId: object.conversationId
        ? String(object.conversationId)
        : null,
      fromIdentity: String(object.from ?? "unknown"),
      toIdentity: object.to ? String(object.to) : null,
      body: String(object.body ?? object.text ?? ""),
      receivedAt: String(object.createdAt ?? new Date().toISOString()),
    };
  }
  return null;
}

async function upsertContact(
  supabase: ReturnType<typeof createClient>,
  primaryIdentity: string,
): Promise<string | null> {
  if (!primaryIdentity || primaryIdentity === "unknown") return null;

  const { data: existing } = await supabase
    .from("contact_identities")
    .select("contact_id")
    .eq("channel", "quo")
    .eq("external_id", primaryIdentity)
    .maybeSingle();
  if (existing?.contact_id) return existing.contact_id;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({ display_name: primaryIdentity, tag: "unknown" })
    .select("id")
    .single();
  if (contactError) {
    console.error("create contact failed", contactError);
    return null;
  }

  const { error: identityError } = await supabase.from("contact_identities").insert({
    contact_id: contact.id,
    channel: "quo",
    external_id: primaryIdentity,
    label: "phone",
  });
  if (identityError) {
    const { data: raced } = await supabase
      .from("contact_identities")
      .select("contact_id")
      .eq("channel", "quo")
      .eq("external_id", primaryIdentity)
      .maybeSingle();
    if (raced?.contact_id) return raced.contact_id;
    console.error("create identity failed", identityError);
  }
  return contact.id;
}

function makeTitle(body: string, from: string): string {
  const cleaned = body.trim().replace(/\s+/g, " ");
  if (!cleaned) return `Text from ${from}`;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
