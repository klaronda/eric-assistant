import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type {
  Channel,
  ChannelStatus,
  ContactTag,
  MessageRow,
  TaskCategory,
  TaskRow,
} from "./lib/types";
import "./App.css";

type Filter = "all" | Channel;
type BucketKey = "now" | "today" | "week" | "fyi" | "junk";

const CHANNELS: { id: Channel; label: string }[] = [
  { id: "quo", label: "Quo" },
  { id: "slack", label: "Slack" },
  { id: "gmail", label: "Gmail" },
];

const GROUPS: { key: BucketKey; label: string; hint?: string }[] = [
  { key: "now", label: "Now", hint: "Urgent — handle today" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "fyi", label: "FYI", hint: "No reply needed" },
  { key: "junk", label: "Junk" },
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
  return mins !== null && mins <= 60 * 24 * 7;
}

function bucketOf(t: TaskRow): BucketKey {
  if (t.category === "junk") return "junk";
  if (t.category === "fyi") return "fyi";
  const u = t.urgency ?? 5;
  if (u >= 8) return "now";
  if (u >= 5) return "today";
  return "week";
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
  const [selected, setSelected] = useState<TaskRow | null>(null);

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

    const latest: Record<Channel, string | null> = { quo: null, slack: null, gmail: null };
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
        return { channel: id, label, lastAt, detail, ok };
      }),
    );
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    const nowIso = new Date().toISOString();
    const { data, error: qError } = await supabase
      .from("tasks")
      .select(
        "id, title, summary, channel, urgency, category, triaged_at, status, snooze_until, created_at, contact_id, source_message_id, contacts(id, display_name, tag)",
      )
      .or(`status.eq.open,and(status.eq.snoozed,snooze_until.lte.${nowIso})`)
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
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => {
        void loadTasks();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, () => {
        void loadStatus();
      })
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    const poll = window.setInterval(() => void loadStatus(), 60_000);

    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(poll);
    };
  }, [session, refresh, loadTasks, loadStatus]);

  const visibleTasks = useMemo(() => {
    if (filter === "all") return tasks;
    return tasks.filter((t) => t.channel === filter);
  }, [tasks, filter]);

  const grouped = useMemo(() => {
    const map: Record<BucketKey, TaskRow[]> = {
      now: [],
      today: [],
      week: [],
      fyi: [],
      junk: [],
    };
    for (const t of visibleTasks) map[bucketOf(t)].push(t);
    return map;
  }, [visibleTasks]);

  const untriagedCount = useMemo(
    () => tasks.filter((t) => !t.triaged_at).length,
    [tasks],
  );

  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setSelected((cur) => (cur?.id === id ? null : cur));
  }

  async function markDone(id: string) {
    const { error: e } = await supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", id);
    if (e) return setError(e.message);
    removeTask(id);
  }

  async function ignoreTask(id: string) {
    const { error: e } = await supabase.from("tasks").update({ status: "ignored" }).eq("id", id);
    if (e) return setError(e.message);
    removeTask(id);
  }

  async function snoozeTask(id: string, until: Date) {
    const { error: e } = await supabase
      .from("tasks")
      .update({ status: "snoozed", snooze_until: until.toISOString() })
      .eq("id", id);
    if (e) return setError(e.message);
    removeTask(id);
  }

  async function setContactTag(contactId: string | null, tag: ContactTag) {
    if (!contactId) return;
    const { error: e } = await supabase.from("contacts").update({ tag }).eq("id", contactId);
    if (e) return setError(e.message);
    setTasks((prev) =>
      prev.map((t) =>
        t.contact_id === contactId && t.contacts ? { ...t, contacts: { ...t.contacts, tag } } : t,
      ),
    );
    setSelected((cur) =>
      cur && cur.contact_id === contactId && cur.contacts
        ? { ...cur, contacts: { ...cur.contacts, tag } }
        : cur,
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

  const totalOpen = visibleTasks.length;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1 className="brand">Eric Assistant</h1>
          <p className="subtitle">Triaged requests from Quo, Slack, and Gmail — sorted by what matters.</p>
        </div>
        <div className="topbar-actions">
          {live && (
            <span className="live-pill">
              <span className="pulse" />
              Live
            </span>
          )}
          <button className="ghost-btn" type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <button className="ghost-btn" type="button" onClick={() => void supabase.auth.signOut()}>
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
                <span
                  className={`dot ${s.ok ? "ok" : "warn"}`}
                  title={s.ok ? "Connected" : "Quiet / check"}
                />
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
            {loading ? "Loading…" : `${totalOpen} open`}
            {untriagedCount > 0 && !loading ? ` · ${untriagedCount} triaging…` : ""}
          </span>
        </div>

        {error && <p className="auth error">{error}</p>}

        {!loading && totalOpen === 0 ? (
          <div className="empty">Nothing open in this filter. You’re clear.</div>
        ) : (
          <div className="groups">
            {GROUPS.map((g) => {
              const items = grouped[g.key];
              if (!items || items.length === 0) return null;
              return (
                <div key={g.key} className={`group group-${g.key}`}>
                  <div className="group-head">
                    <span className="group-label">{g.label}</span>
                    <span className="group-count">{items.length}</span>
                    {g.hint && <span className="group-hint">{g.hint}</span>}
                  </div>
                  <div className="task-list">
                    {items.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onOpen={() => setSelected(task)}
                        onDone={() => void markDone(task.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {selected && (
        <TaskDrawer
          task={selected}
          onClose={() => setSelected(null)}
          onDone={() => void markDone(selected.id)}
          onIgnore={() => void ignoreTask(selected.id)}
          onSnooze={(until) => void snoozeTask(selected.id, until)}
          onTag={(tag) => void setContactTag(selected.contact_id, tag)}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  onOpen,
  onDone,
}: {
  task: TaskRow;
  onOpen: () => void;
  onDone: () => void;
}) {
  return (
    <article className="task" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" ? onOpen() : undefined)}>
      <div className="task-top">
        <div className="task-main">
          <h3 className="task-title">{task.title}</h3>
          {task.summary && <p className="task-summary">{task.summary}</p>}
        </div>
        <div className="badges">
          {task.channel && <span className={`badge ${task.channel}`}>{task.channel}</span>}
          {task.category && <CategoryBadge category={task.category} />}
          {task.urgency != null && <span className="badge urgency">u{task.urgency}</span>}
          {!task.triaged_at && <span className="badge triaging">triaging…</span>}
        </div>
      </div>
      <div className="task-actions" onClick={(e) => e.stopPropagation()}>
        <span className="meta">
          {task.contacts?.display_name || "Unknown"} · {formatFreshness(task.created_at)}
        </span>
        <div className="task-actions-right">
          <button type="button" className="chip-btn" onClick={onOpen}>
            Open
          </button>
          <button type="button" className="chip-btn done" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </article>
  );
}

function CategoryBadge({ category }: { category: TaskCategory }) {
  const label =
    category === "needs_reply" ? "needs reply" : category === "fyi" ? "FYI" : "junk";
  return <span className={`badge cat-${category}`}>{label}</span>;
}

function TaskDrawer({
  task,
  onClose,
  onDone,
  onIgnore,
  onSnooze,
  onTag,
}: {
  task: TaskRow;
  onClose: () => void;
  onDone: () => void;
  onIgnore: () => void;
  onSnooze: (until: Date) => void;
  onTag: (tag: ContactTag) => void;
}) {
  const [message, setMessage] = useState<MessageRow | null>(null);
  const [thread, setThread] = useState<MessageRow[]>([]);
  const [loadingMsg, setLoadingMsg] = useState(true);
  const [draft, setDraft] = useState<string>("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadingMsg(true);
    setMessage(null);
    setThread([]);
    setDraft("");
    setDraftError(null);

    async function load() {
      if (!task.source_message_id) {
        if (active) setLoadingMsg(false);
        return;
      }
      const { data: msg } = await supabase
        .from("messages")
        .select(
          "id, channel, direction, subject, body, from_identity, to_identity, external_thread_id, received_at",
        )
        .eq("id", task.source_message_id)
        .maybeSingle();

      if (!active) return;
      const m = (msg ?? null) as MessageRow | null;
      setMessage(m);

      if (m?.external_thread_id) {
        const { data: threadRows } = await supabase
          .from("messages")
          .select(
            "id, channel, direction, subject, body, from_identity, to_identity, external_thread_id, received_at",
          )
          .eq("channel", m.channel)
          .eq("external_thread_id", m.external_thread_id)
          .order("received_at", { ascending: true })
          .limit(20);
        if (active) setThread((threadRows ?? []) as MessageRow[]);
      }
      setLoadingMsg(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, [task.id, task.source_message_id]);

  async function generateDraft() {
    setDrafting(true);
    setDraftError(null);
    const { data, error } = await supabase.functions.invoke("ai-draft", {
      body: { task_id: task.id },
    });
    setDrafting(false);
    if (error) {
      setDraftError(error.message);
      return;
    }
    setDraft((data as { draft?: string })?.draft ?? "");
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setDraftError("Couldn't copy to clipboard");
    }
  }

  const now = new Date();
  const tonight = new Date(now);
  tonight.setHours(18, 0, 0, 0);
  if (tonight <= now) tonight.setDate(tonight.getDate() + 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);
  nextWeek.setHours(9, 0, 0, 0);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="badges">
            {task.channel && <span className={`badge ${task.channel}`}>{task.channel}</span>}
            {task.category && <CategoryBadge category={task.category} />}
            {task.urgency != null && <span className="badge urgency">u{task.urgency}</span>}
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <h2 className="drawer-title">{task.title}</h2>
        {task.summary && <p className="drawer-summary">{task.summary}</p>}

        <div className="drawer-meta">
          <span>{task.contacts?.display_name || message?.from_identity || "Unknown"}</span>
          <select
            aria-label="Contact tag"
            value={task.contacts?.tag ?? "unknown"}
            onChange={(e) => onTag(e.target.value as ContactTag)}
            disabled={!task.contact_id}
          >
            <option value="unknown">unknown</option>
            <option value="business">business</option>
            <option value="dump">dump</option>
          </select>
        </div>

        <div className="drawer-section">
          <h3>Message</h3>
          {loadingMsg ? (
            <p className="meta">Loading message…</p>
          ) : message ? (
            <div className="message-block">
              {message.subject && <p className="msg-subject">{message.subject}</p>}
              <p className="msg-body">{message.body || "(no body)"}</p>
              <p className="meta">{new Date(message.received_at).toLocaleString()}</p>
            </div>
          ) : (
            <p className="meta">No linked message.</p>
          )}
        </div>

        {thread.length > 1 && (
          <div className="drawer-section">
            <h3>Thread</h3>
            <div className="thread">
              {thread.map((m) => (
                <div key={m.id} className={`thread-msg ${m.direction}`}>
                  <span className="thread-who">{m.direction === "outbound" ? "Eric" : "Them"}</span>
                  <p>{m.body || "(no body)"}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="drawer-section">
          <div className="row-between">
            <h3>Reply draft</h3>
            <button type="button" className="chip-btn" onClick={() => void generateDraft()} disabled={drafting}>
              {drafting ? "Drafting…" : draft ? "Regenerate" : "Draft with AI"}
            </button>
          </div>
          {draftError && <p className="error">{draftError}</p>}
          {draft && (
            <div className="draft-block">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} />
              <div className="row-between">
                <span className="meta">Review before sending — nothing sends automatically.</span>
                <button type="button" className="chip-btn done" onClick={() => void copyDraft()}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="drawer-actions">
          <div className="snooze-row">
            <span className="meta">Snooze:</span>
            <button type="button" className="chip-btn" onClick={() => onSnooze(tonight)}>
              Tonight
            </button>
            <button type="button" className="chip-btn" onClick={() => onSnooze(tomorrow)}>
              Tomorrow
            </button>
            <button type="button" className="chip-btn" onClick={() => onSnooze(nextWeek)}>
              Next week
            </button>
          </div>
          <div className="primary-row">
            <button type="button" className="chip-btn ghost" onClick={onIgnore}>
              Ignore
            </button>
            <button type="button" className="chip-btn done" onClick={onDone}>
              Mark done
            </button>
          </div>
        </div>
      </aside>
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
