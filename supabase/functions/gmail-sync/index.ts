import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const expected = Deno.env.get("GMAIL_INGEST_TOKEN")?.trim();
  if (expected) {
    const provided = url.searchParams.get("token") ??
      req.headers.get("x-eric-ingest-token");
    if (provided !== expected) return json({ error: "Invalid ingest token" }, 401);
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  if (!clientId || !clientSecret) {
    return json({ error: "Missing Google OAuth secrets" }, 500);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: oauthRow } = await supabase
    .from("sync_state")
    .select("value")
    .eq("key", "gmail_oauth")
    .maybeSingle();

  const refreshToken = oauthRow?.value?.refresh_token as string | undefined;
  if (!refreshToken) {
    return json({
      error: "Gmail not connected. Visit gmail-oauth?token=...&action=start",
    }, 400);
  }

  const accessToken = await refreshAccessToken(
    clientId,
    clientSecret,
    refreshToken,
  );

  const { data: histRow } = await supabase
    .from("sync_state")
    .select("value")
    .eq("key", "gmail_history")
    .maybeSingle();

  let historyId = histRow?.value?.history_id
    ? String(histRow.value.history_id)
    : null;

  let messageIds: string[] = [];
  let newHistoryId = historyId;

  if (!historyId) {
    // Bootstrap: recent inbox messages
    const list = await gmailFetch(
      accessToken,
      "/gmail/v1/users/me/messages?maxResults=25&q=in:inbox",
    );
    messageIds = (list.messages ?? []).map((m: { id: string }) => m.id);
    const profile = await gmailFetch(accessToken, "/gmail/v1/users/me/profile");
    newHistoryId = String(profile.historyId);
  } else {
    try {
      const history = await gmailFetch(
        accessToken,
        `/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded`,
      );
      newHistoryId = String(history.historyId ?? historyId);
      const ids = new Set<string>();
      for (const h of history.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      messageIds = [...ids];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404") || msg.includes("notFound")) {
        // History expired — full recent sync
        const list = await gmailFetch(
          accessToken,
          "/gmail/v1/users/me/messages?maxResults=25&q=in:inbox",
        );
        messageIds = (list.messages ?? []).map((m: { id: string }) => m.id);
        const profile = await gmailFetch(
          accessToken,
          "/gmail/v1/users/me/profile",
        );
        newHistoryId = String(profile.historyId);
      } else {
        throw e;
      }
    }
  }

  let inserted = 0;
  let tasks = 0;

  for (const id of messageIds.slice(0, 40)) {
    const result = await ingestMessage(supabase, accessToken, id);
    if (result.inserted) inserted++;
    if (result.taskCreated) tasks++;
  }

  if (newHistoryId) {
    await supabase.from("sync_state").upsert({
      key: "gmail_history",
      value: { history_id: newHistoryId },
      updated_at: new Date().toISOString(),
    });
  }

  return json({
    ok: true,
    scanned: messageIds.length,
    inserted,
    tasks,
    historyId: newHistoryId,
  });
});

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const jsonBody = await res.json();
  if (!res.ok || !jsonBody.access_token) {
    throw new Error(`Refresh failed: ${JSON.stringify(jsonBody)}`);
  }
  return jsonBody.access_token as string;
}

async function gmailFetch(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function ingestMessage(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  messageId: string,
): Promise<{ inserted: boolean; taskCreated: boolean }> {
  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("channel", "gmail")
    .eq("external_message_id", messageId)
    .maybeSingle();
  if (existing?.id) return { inserted: false, taskCreated: false };

  const msg = await gmailFetch(
    accessToken,
    `/gmail/v1/users/me/messages/${messageId}?format=full`,
  );

  const headers = Object.fromEntries(
    (msg.payload?.headers ?? []).map((h: { name: string; value: string }) => [
      h.name.toLowerCase(),
      h.value,
    ]),
  );
  const from = String(headers["from"] ?? "unknown");
  const to = String(headers["to"] ?? "");
  const subject = String(headers["subject"] ?? "");
  const body = extractBody(msg.payload) || String(msg.snippet ?? "");
  const fromEmail = extractEmail(from);
  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : new Date().toISOString();

  const contactId = await upsertContact(supabase, fromEmail, from);

  const { data: inserted, error } = await supabase
    .from("messages")
    .insert({
      channel: "gmail",
      direction: "inbound",
      contact_id: contactId,
      external_message_id: messageId,
      external_thread_id: msg.threadId ?? null,
      from_identity: fromEmail,
      to_identity: to,
      subject,
      body: body.slice(0, 20000),
      raw: { id: messageId, threadId: msg.threadId, snippet: msg.snippet },
      received_at: receivedAt,
    })
    .select("id")
    .single();

  if (error) {
    console.error("gmail insert failed", error);
    return { inserted: false, taskCreated: false };
  }

  let taskCreated = false;
  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("tag")
      .eq("id", contactId)
      .single();
    if (contact?.tag !== "dump") {
      const title = subject || body.trim().slice(0, 80) || `Email from ${fromEmail}`;
      const { error: taskError } = await supabase.from("tasks").insert({
        contact_id: contactId,
        source_message_id: inserted.id,
        channel: "gmail",
        title: title.slice(0, 200),
        summary: (body || msg.snippet || "").slice(0, 500),
        urgency: 4,
        urgency_source: "channel",
        status: "open",
      });
      taskCreated = !taskError;
    }
  }

  return { inserted: true, taskCreated };
}

async function upsertContact(
  supabase: ReturnType<typeof createClient>,
  email: string,
  displayName: string,
): Promise<string | null> {
  if (!email) return null;
  const { data: existing } = await supabase
    .from("contact_identities")
    .select("contact_id")
    .eq("channel", "gmail")
    .eq("external_id", email)
    .maybeSingle();
  if (existing?.contact_id) return existing.contact_id;

  const { data: contact, error } = await supabase
    .from("contacts")
    .insert({
      display_name: displayName.slice(0, 200),
      tag: "unknown",
    })
    .select("id")
    .single();
  if (error) return null;

  await supabase.from("contact_identities").insert({
    contact_id: contact.id,
    channel: "gmail",
    external_id: email,
    label: "email",
  });
  return contact.id;
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  return from.trim().toLowerCase();
}

function extractBody(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const mimeType = String(payload.mimeType ?? "");
  const body = payload.body as { data?: string } | undefined;
  if (mimeType.startsWith("text/") && body?.data) {
    return decodeBase64Url(body.data);
  }
  const parts = payload.parts as Array<Record<string, unknown>> | undefined;
  if (parts?.length) {
    const textPart = parts.find((p) => p.mimeType === "text/plain") ??
      parts.find((p) => String(p.mimeType ?? "").startsWith("text/"));
    if (textPart) {
      const nested = extractBody(textPart);
      if (nested) return nested;
    }
    for (const part of parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(
      Array.from(
        atob(padded),
        (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ).join(""),
    );
  } catch {
    return atob(padded);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
