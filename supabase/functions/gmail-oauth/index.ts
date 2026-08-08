import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const tokenError = checkIngestToken(url);
  if (tokenError) {
    return new Response(tokenError, { status: 401 });
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  if (!clientId || !clientSecret) {
    return html(
      500,
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in Supabase secrets.",
    );
  }

  const redirectUri =
    Deno.env.get("GOOGLE_REDIRECT_URI")?.trim() ||
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/gmail-oauth`;

  const code = url.searchParams.get("code");
  const action = url.searchParams.get("action");

  // Start OAuth
  if (!code && (action === "start" || !url.searchParams.has("code"))) {
    if (action !== "start" && !code) {
      return html(
        200,
        `<p><a href="${escapeHtml(withToken(url, "start"))}">Connect Eric's Gmail</a></p>`,
      );
    }
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", SCOPE);
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "consent");
    auth.searchParams.set("include_granted_scopes", "true");
    // Preserve ingest token across redirect via state
    const ingest = url.searchParams.get("token") ?? "";
    auth.searchParams.set("state", ingest);
    return Response.redirect(auth.toString(), 302);
  }

  // OAuth callback
  const stateToken = url.searchParams.get("state") ?? "";
  const expected = Deno.env.get("GMAIL_INGEST_TOKEN")?.trim();
  if (expected && stateToken !== expected) {
    return html(401, "Invalid OAuth state / ingest token.");
  }

  if (!code) return html(400, "Missing authorization code.");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    return html(
      400,
      `Token exchange failed: ${escapeHtml(JSON.stringify(tokenJson))}. If refresh_token is missing, revoke app access at myaccount.google.com/permissions and try again with prompt=consent.`,
    );
  }

  const profileRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
  );
  const profile = await profileRes.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await supabase.from("sync_state").upsert({
    key: "gmail_oauth",
    value: {
      refresh_token: tokenJson.refresh_token,
      email: profile.emailAddress ?? null,
      history_id: profile.historyId ?? null,
      connected_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return html(500, `Failed to store tokens: ${escapeHtml(error.message)}`);
  }

  // Seed history cursor
  if (profile.historyId) {
    await supabase.from("sync_state").upsert({
      key: "gmail_history",
      value: { history_id: String(profile.historyId) },
      updated_at: new Date().toISOString(),
    });
  }

  return html(
    200,
    `<h1>Gmail connected</h1><p>${escapeHtml(profile.emailAddress ?? "ok")}</p><p>You can close this tab. Next: run gmail-sync.</p>`,
  );
});

function checkIngestToken(url: URL): string | null {
  const expected = Deno.env.get("GMAIL_INGEST_TOKEN")?.trim();
  if (!expected) return null;
  // On OAuth callback, token may be in state instead of query
  if (url.searchParams.get("code")) {
    const state = url.searchParams.get("state");
    if (state !== expected) return "Invalid ingest token (state)";
    return null;
  }
  if (url.searchParams.get("token") !== expected) return "Invalid ingest token";
  return null;
}

function withToken(url: URL, action: string): string {
  const next = new URL(url.toString());
  next.searchParams.set("action", action);
  return next.toString();
}

function html(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:2rem">${body}</body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
