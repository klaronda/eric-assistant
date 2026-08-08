import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// On-demand sync: force a Gmail pull, then run AI triage a few times.
// JWT-protected (verify_jwt = true) so only signed-in dashboard users can trigger it.
// Quo and Slack are push webhooks, so there is nothing to pull for them.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const gmailToken = Deno.env.get("GMAIL_INGEST_TOKEN")?.trim() ?? "";
  const aiToken = Deno.env.get("AI_INGEST_TOKEN")?.trim() ?? "";

  const result: Record<string, unknown> = {};

  // 1) Force a Gmail pull
  try {
    const r = await fetch(`${base}/gmail-sync?token=${encodeURIComponent(gmailToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    result.gmail = await safeJson(r);
  } catch (e) {
    result.gmail = { error: String(e) };
  }

  // 2) Run triage until the backlog is cleared (cap the loops)
  let triagedTotal = 0;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${base}/ai-triage?token=${encodeURIComponent(aiToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await safeJson(r)) as { triaged?: number; batch?: number };
      triagedTotal += data?.triaged ?? 0;
      if (!data?.batch || data.batch === 0) break;
    } catch (e) {
      result.triageError = String(e);
      break;
    }
  }
  result.triaged = triagedTotal;

  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return { status: r.status };
  }
}
