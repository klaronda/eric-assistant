import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "gpt-4o-mini";
const BATCH = 15;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authError = authorize(req);
  if (authError) return json({ error: authError }, 401);

  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPEN_AI_SECRET");
  if (!openaiKey) return json({ error: "OPENAI_API_KEY / OPEN_AI_SECRET not set" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select(
      "id, title, channel, created_at, source_message_id, message:source_message_id(subject, body, from_identity), contacts(display_name, tag)",
    )
    .is("triaged_at", null)
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) return json({ error: error.message }, 500);
  if (!tasks || tasks.length === 0) return json({ ok: true, triaged: 0 });

  const items = tasks.map((t) => {
    const msg = (t as Record<string, unknown>).message as
      | { subject?: string; body?: string; from_identity?: string }
      | null;
    const contact = (t as Record<string, unknown>).contacts as
      | { display_name?: string; tag?: string }
      | null;
    return {
      id: t.id as string,
      channel: t.channel as string,
      from: contact?.display_name || msg?.from_identity || "unknown",
      subject: msg?.subject ?? "",
      body: (msg?.body ?? (t.title as string) ?? "").slice(0, 1500),
    };
  });

  let results: TriageResult[];
  try {
    results = await classify(items, openaiKey);
  } catch (e) {
    console.error("openai error", e);
    return json({ error: `OpenAI request failed: ${String(e)}` }, 502);
  }

  const byId = new Map(results.map((r) => [r.id, r]));
  let triaged = 0;

  for (const item of items) {
    const r = byId.get(item.id);
    if (!r) continue;
    const urgency = clampUrgency(r.urgency);
    const category = normalizeCategory(r.category);
    const patch: Record<string, unknown> = {
      summary: (r.summary ?? "").slice(0, 500),
      urgency,
      urgency_source: "model",
      category,
      triaged_at: new Date().toISOString(),
    };
    if (r.title && r.title.trim()) patch.title = r.title.trim().slice(0, 120);

    const { error: upErr } = await supabase.from("tasks").update(patch).eq("id", item.id);
    if (upErr) console.error("update task failed", item.id, upErr);
    else triaged += 1;
  }

  return json({ ok: true, triaged, batch: items.length });
});

type TriageResult = {
  id: string;
  title?: string;
  summary?: string;
  urgency?: number;
  category?: string;
};

async function classify(
  items: Array<{ id: string; channel: string; from: string; subject: string; body: string }>,
  apiKey: string,
): Promise<TriageResult[]> {
  const system =
    "You are the triage engine for Eric, who runs Pacific Dream Photography. " +
    "You read incoming messages (texts, Slack, email) and turn each into a concise, actionable task. " +
    "For each item return: a short imperative title (max 10 words), a one-sentence summary, " +
    "an urgency 1-10, and a category. " +
    "Categories: 'needs_reply' = Eric must respond or take action; " +
    "'fyi' = informational, no response needed; " +
    "'junk' = marketing, spam, newsletters, automated notifications with no action. " +
    "Urgency scale: 8-10 = time-sensitive client/booking/payment or angry customer; " +
    "5-7 = normal client request or coordination; 1-4 = low priority or non-client. " +
    "Junk should be urgency 1. Respond ONLY with JSON.";

  const user = {
    instructions:
      "Classify every item. Return {\"results\":[{\"id\",\"title\",\"summary\",\"urgency\",\"category\"}]} with one entry per input id.",
    items,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  const results = Array.isArray(parsed) ? parsed : parsed.results ?? [];
  return results as TriageResult[];
}

function clampUrgency(u: unknown): number {
  const n = Math.round(Number(u));
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, n));
}

function normalizeCategory(c: unknown): string {
  const v = String(c ?? "").toLowerCase();
  if (v === "needs_reply" || v === "fyi" || v === "junk") return v;
  if (v.includes("reply") || v.includes("action")) return "needs_reply";
  if (v.includes("junk") || v.includes("spam")) return "junk";
  return "fyi";
}

function authorize(req: Request): string | null {
  const expected = Deno.env.get("AI_INGEST_TOKEN")?.trim();
  const provided = new URL(req.url).searchParams.get("token") ??
    req.headers.get("x-eric-ingest-token");
  if (expected && provided !== expected) return "Invalid ingest token";
  if (!expected) console.warn("AI_INGEST_TOKEN unset — accepting request (bootstrap)");
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
