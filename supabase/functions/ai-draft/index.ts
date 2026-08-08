import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "gpt-4o-mini";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPEN_AI_SECRET");
  if (!openaiKey) return json({ error: "OPENAI_API_KEY / OPEN_AI_SECRET not set" }, 500);

  let body: { task_id?: string; guidance?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body.task_id) return json({ error: "task_id required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: task, error } = await supabase
    .from("tasks")
    .select(
      "id, title, summary, channel, source_message_id, message:source_message_id(subject, body, from_identity, external_thread_id), contacts(display_name, tag)",
    )
    .eq("id", body.task_id)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!task) return json({ error: "Task not found" }, 404);

  const msg = (task as Record<string, unknown>).message as
    | { subject?: string; body?: string; from_identity?: string; external_thread_id?: string }
    | null;
  const contact = (task as Record<string, unknown>).contacts as
    | { display_name?: string }
    | null;

  let thread = "";
  if (msg?.external_thread_id) {
    const { data: threadMsgs } = await supabase
      .from("messages")
      .select("direction, body, received_at")
      .eq("channel", task.channel as string)
      .eq("external_thread_id", msg.external_thread_id)
      .order("received_at", { ascending: true })
      .limit(10);
    thread = (threadMsgs ?? [])
      .map((m) => `${m.direction === "outbound" ? "Eric" : "Them"}: ${String(m.body ?? "").slice(0, 400)}`)
      .join("\n");
  }

  let draft: string;
  try {
    draft = await generate(
      {
        channel: task.channel as string,
        from: contact?.display_name || msg?.from_identity || "the sender",
        subject: msg?.subject ?? "",
        message: msg?.body ?? (task.title as string) ?? "",
        thread,
        guidance: body.guidance ?? "",
      },
      openaiKey,
    );
  } catch (e) {
    console.error("openai error", e);
    return json({ error: `OpenAI request failed: ${String(e)}` }, 502);
  }

  const { data: inserted, error: insErr } = await supabase
    .from("drafts")
    .insert({
      task_id: task.id,
      reply_to_message_id: task.source_message_id,
      channel: task.channel,
      body: draft,
      status: "pending",
      model: MODEL,
    })
    .select("id")
    .single();

  if (insErr) console.error("insert draft failed", insErr);

  return json({ ok: true, draft, draft_id: inserted?.id ?? null });
});

async function generate(
  ctx: {
    channel: string;
    from: string;
    subject: string;
    message: string;
    thread: string;
    guidance: string;
  },
  apiKey: string,
): Promise<string> {
  const tone =
    ctx.channel === "gmail"
      ? "a professional but warm email reply"
      : "a brief, friendly text-message reply";

  const system =
    "You draft replies on behalf of Eric, owner of Pacific Dream Photography. " +
    `Write ${tone}. Be concise, human, and helpful. ` +
    "Do not invent specific prices, dates, or commitments Eric hasn't made — if details are needed, ask for them or leave a clear placeholder in [brackets]. " +
    "Return only the reply text, no preamble.";

  const parts = [
    `Channel: ${ctx.channel}`,
    `From: ${ctx.from}`,
    ctx.subject ? `Subject: ${ctx.subject}` : "",
    ctx.thread ? `Conversation so far:\n${ctx.thread}` : `Message:\n${ctx.message}`,
    ctx.guidance ? `Eric's guidance for the reply: ${ctx.guidance}` : "",
  ].filter(Boolean);

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      messages: [
        { role: "system", content: system },
        { role: "user", content: parts.join("\n\n") },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
