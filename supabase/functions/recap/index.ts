import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Last-24-hours recap for Eric: a short assistant-style narrative plus the
// structured facts (stats + the items that still need a reply). JWT-protected
// so only signed-in dashboard users can generate it.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "gpt-4o-mini";

type NeedsItem = {
  title: string;
  contact: string;
  urgency: number;
  channel: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();

  const [msgsRes, tasksRes, handledRes, autoRes, newTasksRes] = await Promise.all([
    supabase
      .from("messages")
      .select("channel")
      .eq("direction", "inbound")
      .gte("received_at", since),
    supabase
      .from("tasks")
      .select(
        "title, urgency, channel, category, status, snooze_until, created_at, contacts(display_name, tag)",
      )
      .or(`status.eq.open,and(status.eq.snoozed,snooze_until.lte.${nowIso})`)
      .order("urgency", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "done")
      .gte("completed_at", since),
    supabase
      .from("auto_responses")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    supabase.from("tasks").select("category").gte("created_at", since),
  ]);

  const newByChannel: Record<string, number> = { quo: 0, slack: 0, gmail: 0 };
  for (const row of (msgsRes.data ?? []) as Array<{ channel: string }>) {
    if (row.channel in newByChannel) newByChannel[row.channel] += 1;
  }
  const newTotal = (msgsRes.data ?? []).length;

  const openTasks = (tasksRes.data ?? []) as Array<{
    title: string;
    urgency: number | null;
    channel: string | null;
    category: string | null;
    contacts: { display_name: string | null; tag: string | null } | null;
  }>;

  const needsReplyAll = openTasks.filter(
    (t) => t.category !== "fyi" && t.category !== "junk",
  );
  const needsReply: NeedsItem[] = needsReplyAll.slice(0, 6).map((t) => ({
    title: t.title,
    contact: t.contacts?.display_name || "Unknown",
    urgency: t.urgency ?? 5,
    channel: t.channel,
  }));
  const urgent = needsReplyAll.filter((t) => (t.urgency ?? 0) >= 8).length;

  const newCats = (newTasksRes.data ?? []) as Array<{ category: string | null }>;
  const fyi = newCats.filter((t) => t.category === "fyi").length;
  const junk = newCats.filter((t) => t.category === "junk").length;

  const stats = {
    newTotal,
    newByChannel,
    needsReply: needsReplyAll.length,
    urgent,
    handled: handledRes.count ?? 0,
    autoReplies: autoRes.count ?? 0,
  };

  const summary = await writeSummary({ stats, needsReply, fyi, junk });

  return json({
    ok: true,
    generatedAt: nowIso,
    summary,
    stats,
    needsReply,
    fyi,
    junk,
  });
});

async function writeSummary(ctx: {
  stats: {
    newTotal: number;
    newByChannel: Record<string, number>;
    needsReply: number;
    urgent: number;
    handled: number;
    autoReplies: number;
  };
  needsReply: NeedsItem[];
  fyi: number;
  junk: number;
}): Promise<string> {
  const { stats } = ctx;
  const fallback =
    `${stats.newTotal} new request${stats.newTotal === 1 ? "" : "s"} came in over the last 24 hours, ` +
    `and ${stats.needsReply} still need your reply` +
    (stats.urgent > 0 ? `, including ${stats.urgent} time-sensitive` : "") +
    `. I cleared ${stats.handled} for you` +
    (stats.autoReplies > 0 ? ` and auto-acknowledged ${stats.autoReplies} while you were out` : "") +
    ".";

  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPEN_AI_SECRET");
  if (!apiKey) return fallback;

  const system =
    "You are Eric's executive assistant at Pacific Dream Photography. " +
    "Write a concise, professional recap of the last 24 hours for Eric, who is a director. " +
    "Two to three sentences. Do NOT greet or use his name — start with the substance. " +
    "Use only the facts provided; never invent tasks, names, prices, or dates. " +
    "If there are standout items that need a reply, mention the top one or two by contact/topic. " +
    "Warm but efficient tone. Return plain text only.";

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 160,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(ctx) },
        ],
      }),
    });
    if (!resp.ok) return fallback;
    const data = await resp.json();
    const text = String(data.choices?.[0]?.message?.content ?? "").trim();
    return text || fallback;
  } catch (e) {
    console.error("recap summary failed", e);
    return fallback;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
