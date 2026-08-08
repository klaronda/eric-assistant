import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { Channel, ChannelStatus, ContactTag, TaskRow } from "./lib/types";
import "./App.css";

type Filter = "all" | Channel;

const CHANNELS: { id: Channel; label: string }[] = [
  { id: "quo", label: "Quo" },
  { id: "slack", label: "Slack" },
  { id: "gmail", label: "Gmail" },
];

function minutesAgo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

function formatFreshness(iso: string | null): string {
  const mins = minutesAgo(iso);
  if (mins === null) return "No activity yet";
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(iso!).toLocaleString();
}

function channelOk(channel: Channel, lastAt: string | null, gmailSyncAt: string | null): boolean {
  if (channel === "gmail") {
    const mins = minutesAgo(gmailSyncAt ?? lastAt);
    return mins !== null && mins <= 45;
  }
  const mins = minutesAgo(lastAt);
  // Webhooks can be quiet; green if we've ever seen data and not stale > 7 days
  return mins !== null && mins <= 60 * 24 * 7;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [statuses, setStatuses] = useState<ChannelStatus[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadStatus = useCallback(async () => {
    const [{ data: messages }, { data: sync }, { data: oauth }] = await Promise.all([
      supabase
        .from("messages")
        .select("channel, created_at, received_at")
        .order("created_at", { ascending: false })
        .limit(300),
      supabase
        .from("sync_state")
        .select("key, value, updated_at")
        .eq("key", "gmail_history")
        .maybeSingle(),
      supabase
        .from("sync_state")
        .select("value, updated_at")
        .eq("key", "gmail_oauth")
        .maybeSingle(),
    ]);

    const latest: Record<Channel, string | null> = {
      quo: null,
      slack: null,
      gmail: null,
    };
    for (const row of (messages ?? []) as Array<{
      channel: Channel;
      created_at: string;
      received_at: string;
    }>) {
      if (!latest[row.channel]) latest[row.channel] = row.created_at ?? row.received_at;
    }

    const gmailSyncAt = (sync as { updated_at?: string } | null)?.updated_at ?? null;
    const oauthRow = oauth as { value?: { email?: string }; updated_at?: string } | null;
    const connectedEmail = oauthRow?.value?.email || "Inbox sync";

    setStatuses(
      CHANNELS.map(({ id, label }) => {
        const lastAt = latest[id];
        const ok = channelOk(
          id,
          lastAt,
          id === "gmail" ? gmailSyncAt ?? oauthRow?.updated_at ?? null : null,
        );
        let detail = formatFreshness(lastAt);
        if (id === "gmail") {
          detail = `${connectedEmail} · sync ${formatFreshness(gmailSyncAt ?? oauthRow?.updated_at ?? null)}`;
        }
        return {
          channel: id,
          label,
          lastAt,
          detail,
          ok,
        };
      }),
    );
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: qError } = await supabase
      .from("tasks")
      .select(
        "id, title, summary, channel, urgency, status, created_at, contact_id, contacts(id, display_name, tag)",
      )
      .eq("status", "open")
      .order("urgency", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (qError) {
      setError(qError.message);
      setTasks([]);
    } else {
      setTasks((data ?? []) as unknown as TaskRow[]);
    }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadTasks(), loadStatus()]);
  }, [loadTasks, loadStatus]);

  useEffect(() => {
    if (!session) return;
    void refresh();

    const channel = supabase
      .channel("eric-dashboard")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        () => {
          void loadStatus();
        },
      )
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
      });

    const poll = window.setInterval(() => {
      void loadStatus();
    }, 60_000);

    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(poll);
    };
  }, [session, refresh, loadStatus]);

  const visibleTasks = useMemo(() => {
    if (filter === "all") return tasks;
    return tasks.filter((t) => t.channel === filter);
  }, [tasks, filter]);

  async function markDone(id: string) {
    const { error: upError } = await supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", id);
    if (upError) {
      setError(upError.message);
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  async function setContactTag(contactId: string | null, tag: ContactTag) {
    if (!contactId) return;
    const { error: upError } = await supabase.from("contacts").update({ tag }).eq("id", contactId);
    if (upError) {
      setError(upError.message);
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.contact_id === contactId && t.contacts
          ? { ...t, contacts: { ...t.contacts, tag } }
          : t,
      ),
    );
  }

  if (!authReady) {
    return (
      <div className="app">
        <p className="meta">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return <AuthScreen onSignedIn={() => void refresh()} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1 className="brand">Eric Assistant</h1>
          <p className="subtitle">Open requests from Quo, Slack, and Gmail — one list.</p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          {live && (
            <span className="live-pill">
              <span className="pulse" />
              Live
            </span>
          )}
          <button className="ghost-btn" type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            className="ghost-btn"
            type="button"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </header>

      <section className="panel">
        <h2>Connections</h2>
        <div className="status-grid">
          {statuses.map((s) => (
            <article key={s.channel} className="status-card">
              <div className="row">
                <span className="name">{s.label}</span>
                <span className={`dot ${s.ok ? "ok" : "warn"}`} title={s.ok ? "Connected" : "Quiet / check"} />
              </div>
              <p className="detail">{s.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="toolbar">
          <div className="filters">
            {(["all", "quo", "slack", "gmail"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`filter ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : f}
              </button>
            ))}
          </div>
          <span className="meta">
            {loading ? "Loading…" : `${visibleTasks.length} open`}
          </span>
        </div>

        {error && <p className="auth error">{error}</p>}

        {!loading && visibleTasks.length === 0 ? (
          <div className="empty">Nothing open in this filter. You’re clear.</div>
        ) : (
          <div className="task-list">
            {visibleTasks.map((task) => (
              <article key={task.id} className="task">
                <div className="task-top">
                  <div>
                    <h3 className="task-title">{task.title}</h3>
                    {task.summary && <p className="task-summary">{task.summary}</p>}
                  </div>
                  <div className="badges">
                    {task.channel && (
                      <span className={`badge ${task.channel}`}>{task.channel}</span>
                    )}
                    {task.urgency != null && (
                      <span className="badge">u{task.urgency}</span>
                    )}
                    {task.contacts?.tag && (
                      <span className="badge">{task.contacts.tag}</span>
                    )}
                  </div>
                </div>
                <div className="task-actions">
                  <span className="meta">
                    {task.contacts?.display_name || "Unknown"} ·{" "}
                    {new Date(task.created_at).toLocaleString()}
                  </span>
                  <select
                    aria-label="Contact tag"
                    value={task.contacts?.tag ?? "unknown"}
                    onChange={(e) =>
                      void setContactTag(task.contact_id, e.target.value as ContactTag)
                    }
                    disabled={!task.contact_id}
                  >
                    <option value="unknown">unknown</option>
                    <option value="business">business</option>
                    <option value="dump">dump</option>
                  </select>
                  <button
                    type="button"
                    className="chip-btn done"
                    onClick={() => void markDone(task.id)}
                  >
                    Mark done
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const action =
      mode === "signin"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error: authError } = await action;
    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    onSignedIn();
  }

  return (
    <div className="panel auth">
      <h1>Eric Assistant</h1>
      <p>Sign in to see live Quo, Slack, and Gmail requests.</p>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
        <button
          className="ghost-btn"
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
