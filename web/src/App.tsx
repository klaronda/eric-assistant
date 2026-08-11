import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { supabase } from "./lib/supabase";
import type {
  Channel,
  ChannelStatus,
  ContactTag,
  MessageRow,
  TaskCategory,
  TaskRow,
} from "./lib/types";
import {
  CUSTOM_SCAFFOLD,
  DEFAULT_SETTINGS,
  PRESETS,
  previewMessage,
} from "./lib/autoresponder";
import type { AutoResponderSettings, Preset } from "./lib/autoresponder";
import "./App.css";

type Filter = "all" | Channel;
type UrgencyLevel = "high" | "med" | "low";

type RecapStats = {
  newTotal: number;
  newByChannel: Record<Channel, number>;
  needsReply: number;
  urgent: number;
  handled: number;
  autoReplies: number;
};

type RecapNeedsItem = {
  title: string;
  contact: string;
  urgency: number;
  channel: Channel | null;
};

type Recap = {
  generatedAt: string;
  summary: string;
  stats: RecapStats;
  needsReply: RecapNeedsItem[];
  fyi: number;
  junk: number;
};

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

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
  return new Date(iso!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function channelOk(channel: Channel, lastAt: string | null, gmailSyncAt: string | null): boolean {
  if (channel === "gmail") {
    const mins = minutesAgo(gmailSyncAt ?? lastAt);
    return mins !== null && mins <= 45;
  }
  const mins = minutesAgo(lastAt);
  return mins !== null && mins <= 60 * 24 * 7;
}

function urgencyLevel(u: number | null): UrgencyLevel {
  const v = u ?? 5;
  if (v >= 8) return "high";
  if (v >= 5) return "med";
  return "low";
}

function urgencyLabel(level: UrgencyLevel): string {
  return level === "high" ? "Now" : level === "med" ? "Today" : "Later";
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
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<TaskRow | null>(null);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [settings, setSettings] = useState<AutoResponderSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
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
        "id, title, summary, channel, urgency, category, triaged_at, status, snooze_until, position, created_at, contact_id, source_message_id, contacts(id, display_name, tag)",
      )
      .or(`status.eq.open,and(status.eq.snoozed,snooze_until.lte.${nowIso})`)
      .order("position", { ascending: true })
      .order("created_at", { ascending: false });

    if (qError) {
      setError(qError.message);
      setTasks([]);
    } else {
      setTasks((data ?? []) as unknown as TaskRow[]);
    }
    setLoading(false);
  }, []);

  const loadRecap = useCallback(async () => {
    setRecapLoading(true);
    const { data, error: e } = await supabase.functions.invoke("recap", { body: {} });
    if (e) setError(`Recap failed: ${e.message}`);
    else if (data) setRecap(data as Recap);
    setRecapLoading(false);
  }, []);

  const loadSettings = useCallback(async () => {
    const { data } = await supabase
      .from("autoresponder_settings")
      .select("enabled, preset, custom_message, respond_quo, respond_slack, cooldown_hours")
      .eq("id", true)
      .maybeSingle();
    if (data) setSettings(data as AutoResponderSettings);
  }, []);

  const saveSettings = useCallback(
    async (next: AutoResponderSettings) => {
      setSettings(next);
      const { error: e } = await supabase
        .from("autoresponder_settings")
        .update({
          enabled: next.enabled,
          preset: next.preset,
          custom_message: next.custom_message,
          respond_quo: next.respond_quo,
          respond_slack: next.respond_slack,
          cooldown_hours: next.cooldown_hours,
        })
        .eq("id", true);
      if (e) setError(e.message);
    },
    [],
  );

  const refresh = useCallback(async () => {
    await Promise.all([loadTasks(), loadStatus(), loadSettings()]);
  }, [loadTasks, loadStatus, loadSettings]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setError(null);
    const { error: e } = await supabase.functions.invoke("sync-now", { body: {} });
    if (e) setError(`Sync failed: ${e.message}`);
    await refresh();
    setSyncing(false);
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    void loadRecap();

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
  }, [session, refresh, loadTasks, loadStatus, loadRecap]);

  const filtered = useMemo(() => {
    if (filter === "all") return tasks;
    return tasks.filter((t) => t.channel === filter);
  }, [tasks, filter]);

  const priority = useMemo(
    () =>
      filtered
        .filter((t) => t.category !== "fyi" && t.category !== "junk")
        .sort((a, b) => a.position - b.position),
    [filtered],
  );
  const fyi = useMemo(() => filtered.filter((t) => t.category === "fyi"), [filtered]);
  const junk = useMemo(() => filtered.filter((t) => t.category === "junk"), [filtered]);
  const untriagedCount = useMemo(() => tasks.filter((t) => !t.triaged_at).length, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setSelected((cur) => (cur?.id === id ? null : cur));
  }

  function patchTask(id: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setSelected((cur) => (cur?.id === id ? { ...cur, ...patch } : cur));
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

  async function setCategory(id: string, category: TaskCategory) {
    patchTask(id, { category });
    const { error: e } = await supabase.from("tasks").update({ category }).eq("id", id);
    if (e) setError(e.message);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = priority.findIndex((t) => t.id === active.id);
    const newIndex = priority.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(priority, oldIndex, newIndex);
    const prev = reordered[newIndex - 1];
    const next = reordered[newIndex + 1];
    let newPos: number;
    if (!prev) newPos = (next ? next.position : 1) - 1;
    else if (!next) newPos = prev.position + 1;
    else newPos = (prev.position + next.position) / 2;

    patchTask(String(active.id), { position: newPos });
    const { error: e } = await supabase
      .from("tasks")
      .update({ position: newPos })
      .eq("id", active.id);
    if (e) setError(e.message);
  }

  if (!authReady) {
    return (
      <div className="app">
        <p className="meta">Loading…</p>
      </div>
    );
  }
  if (!session) return <AuthScreen onSignedIn={() => void refresh()} />;

  const canDrag = filter === "all";

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1 className="brand">Eric Assistant</h1>
          <p className="subtitle">Your requests from Quo, Slack &amp; Gmail — triaged and in one place.</p>
        </div>
        <div className="topbar-actions">
          {live && (
            <span className="live-pill">
              <span className="pulse" />
              Live
            </span>
          )}
          <button
            className="primary-btn compact"
            type="button"
            onClick={() => void syncNow()}
            disabled={syncing}
            title="Fetch new Gmail now and re-run triage (Quo & Slack arrive instantly on their own)"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="ghost-btn" type="button" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <RecapBanner recap={recap} loading={recapLoading} onRefresh={() => void loadRecap()} />

      <AutoResponderPanel settings={settings} onSave={(s) => void saveSettings(s)} />

      <Legend />
      <HowTo />

      <section className="panel connections">
        <div className="connections-row">
          <span className="panel-eyebrow">Connections</span>
          <div className="conn-chips">
            {statuses.map((s) => (
              <span key={s.channel} className="conn-chip" title={s.detail}>
                <span className={`dot ${s.ok ? "ok" : "warn"}`} />
                {s.label}
                <span className="conn-detail">{s.detail}</span>
              </span>
            ))}
          </div>
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
            {loading ? "Loading…" : `${priority.length} to handle`}
            {untriagedCount > 0 && !loading ? ` · ${untriagedCount} triaging…` : ""}
          </span>
        </div>

        {error && <p className="error">{error}</p>}

        {!loading && priority.length === 0 ? (
          <div className="empty">Nothing to handle right now. You’re clear. 🌊</div>
        ) : canDrag ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={priority.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <div className="list">
                {priority.map((task) => (
                  <SortableTaskCard
                    key={task.id}
                    task={task}
                    onOpen={() => setSelected(task)}
                    onDone={() => void markDone(task.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="list">
            {priority.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onOpen={() => setSelected(task)}
                onDone={() => void markDone(task.id)}
              />
            ))}
            <p className="meta drag-note">Switch to “All” to drag and reorder.</p>
          </div>
        )}
      </section>

      {fyi.length > 0 && (
        <details className="panel section">
          <summary>
            <span className="section-title">FYI</span>
            <span className="section-count">{fyi.length}</span>
            <span className="section-hint">Informational — no reply needed</span>
          </summary>
          <div className="list compact">
            {fyi.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onOpen={() => setSelected(task)}
                onDone={() => void markDone(task.id)}
              />
            ))}
          </div>
        </details>
      )}

      {junk.length > 0 && (
        <details className="panel section muted">
          <summary>
            <span className="section-title">Junk</span>
            <span className="section-count">{junk.length}</span>
            <span className="section-hint">Marketing, spam, automated</span>
          </summary>
          <div className="list compact">
            {junk.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onOpen={() => setSelected(task)}
                onDone={() => void markDone(task.id)}
              />
            ))}
          </div>
        </details>
      )}

      {selected && (
        <TaskDrawer
          task={selected}
          onClose={() => setSelected(null)}
          onDone={() => void markDone(selected.id)}
          onIgnore={() => void ignoreTask(selected.id)}
          onSnooze={(until) => void snoozeTask(selected.id, until)}
          onTag={(tag) => void setContactTag(selected.contact_id, tag)}
          onCategory={(c) => void setCategory(selected.id, c)}
        />
      )}
    </div>
  );
}

function RecapBanner({
  recap,
  loading,
  onRefresh,
}: {
  recap: Recap | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const chips: { label: string; value: number; tone?: string }[] = recap
    ? [
        { label: "new requests", value: recap.stats.newTotal },
        { label: "need reply", value: recap.stats.needsReply, tone: "amber" },
        {
          label: "urgent",
          value: recap.stats.urgent,
          tone: recap.stats.urgent > 0 ? "red" : undefined,
        },
        { label: "handled", value: recap.stats.handled, tone: "green" },
        { label: "auto-replies", value: recap.stats.autoReplies },
      ]
    : [];

  return (
    <section className="panel recap">
      <div className="recap-head">
        <div>
          <span className="panel-eyebrow">Last 24 hours</span>
          <p className="recap-sub">
            {recap
              ? `Updated ${formatFreshness(recap.generatedAt)}`
              : "Your daily briefing"}
          </p>
        </div>
        <button
          className="ghost-btn compact"
          type="button"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {!recap ? (
        <p className="meta">{loading ? "Writing your recap…" : "No activity yet."}</p>
      ) : (
        <>
          <p className="recap-greeting">
            {greetingForNow()}, Eric.
          </p>
          <p className="recap-summary">{recap.summary}</p>

          <div className="recap-stats">
            {chips.map((s) => (
              <div key={s.label} className={`recap-stat ${s.tone ?? ""}`}>
                <span className="recap-num">{s.value}</span>
                <span className="recap-label">{s.label}</span>
              </div>
            ))}
            <div className="recap-channels">
              {(["quo", "slack", "gmail"] as Channel[]).map((c) => (
                <span key={c} className="recap-chan">
                  <span className={`badge ${c}`}>{c}</span>
                  {recap.stats.newByChannel[c] ?? 0}
                </span>
              ))}
            </div>
          </div>

          {recap.needsReply.length > 0 && (
            <div className="recap-section">
              <span className="recap-section-title">Needs your reply</span>
              <ul className="recap-list">
                {recap.needsReply.map((item, i) => (
                  <li key={i}>
                    <span className="recap-item-title">{item.title}</span>
                    <span className="recap-item-meta">
                      {item.channel && <span className={`badge ${item.channel}`}>{item.channel}</span>}
                      <span>{item.contact}</span>
                      {item.urgency >= 8 && <span className="recap-tag urgent">time-sensitive</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="recap-footnotes">
            <span>
              <strong>{recap.stats.handled}</strong> handled for you
            </span>
            <span>
              <strong>{recap.stats.autoReplies}</strong> auto-replied while out
            </span>
            <span>
              <strong>{recap.fyi}</strong> FYI · <strong>{recap.junk}</strong> junk filed
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function AutoResponderPanel({
  settings,
  onSave,
}: {
  settings: AutoResponderSettings;
  onSave: (s: AutoResponderSettings) => void;
}) {
  const preview = previewMessage(settings);

  function update(patch: Partial<AutoResponderSettings>) {
    onSave({ ...settings, ...patch });
  }

  function selectPreset(preset: Preset) {
    if (preset === "custom" && !settings.custom_message) {
      onSave({ ...settings, preset, custom_message: CUSTOM_SCAFFOLD });
    } else {
      onSave({ ...settings, preset });
    }
  }

  return (
    <details className="panel autoresp" open={settings.enabled}>
      <summary>
        <span className="section-title">Auto-reply</span>
        <span className={`ar-state ${settings.enabled ? "on" : "off"}`}>
          {settings.enabled ? "ON" : "OFF"}
        </span>
        <span className="section-hint">
          Acknowledge texts &amp; Slack DMs when you&apos;re heads-down
        </span>
      </summary>

      <div className="ar-body">
        <label className="ar-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span>
            <strong>{settings.enabled ? "Auto-reply is on" : "Auto-reply is off"}</strong>
            <span className="meta">
              {settings.enabled
                ? "New senders get one courteous acknowledgment."
                : "Turn on to reply automatically. Off is safe for testing."}
            </span>
          </span>
        </label>

        {settings.enabled && (
          <p className="ar-live-note">
            Live: each person gets one auto-reply, then not again for{" "}
            {settings.cooldown_hours}h. Replies with “URGENT” jump to the top of your list.
          </p>
        )}

        <div className="ar-field">
          <span className="ar-label">Message</span>
          <div className="ar-presets">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`ar-preset ${settings.preset === p.key ? "active" : ""}`}
                onClick={() => selectPreset(p.key)}
              >
                <span className="ar-preset-label">{p.label}</span>
                <span className="ar-preset-hint">{p.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {settings.preset === "custom" && (
          <div className="ar-field">
            <span className="ar-label">Custom message</span>
            <textarea
              className="ar-custom"
              rows={3}
              value={settings.custom_message ?? ""}
              placeholder={CUSTOM_SCAFFOLD}
              onChange={(e) => update({ custom_message: e.target.value })}
            />
            <span className="meta">
              Keep <code>[paraphrase request]</code> where you want the AI to summarize their ask.
            </span>
          </div>
        )}

        <div className="ar-field">
          <span className="ar-label">Preview</span>
          <div className="ar-preview">{preview}</div>
        </div>

        <div className="ar-options">
          <span className="ar-label">Respond on</span>
          <label className="ar-check">
            <input
              type="checkbox"
              checked={settings.respond_quo}
              onChange={(e) => update({ respond_quo: e.target.checked })}
            />
            <span className="badge quo">Quo</span> texts
          </label>
          <label className="ar-check">
            <input
              type="checkbox"
              checked={settings.respond_slack}
              onChange={(e) => update({ respond_slack: e.target.checked })}
            />
            <span className="badge slack">Slack</span> DMs
          </label>
          <label className="ar-cooldown">
            Once per person every
            <select
              value={settings.cooldown_hours}
              onChange={(e) => update({ cooldown_hours: Number(e.target.value) })}
            >
              <option value={1}>1h</option>
              <option value={4}>4h</option>
              <option value={8}>8h</option>
              <option value={24}>24h</option>
            </select>
          </label>
        </div>
      </div>
    </details>
  );
}

function Legend() {
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-label">Priority</span>
        <span className="legend-item">
          <span className="swatch high" /> Now
        </span>
        <span className="legend-item">
          <span className="swatch med" /> Today
        </span>
        <span className="legend-item">
          <span className="swatch low" /> Later
        </span>
      </div>
      <div className="legend-group">
        <span className="legend-label">Channels</span>
        <span className="legend-item">
          <span className="badge quo">Quo</span> texts
        </span>
        <span className="legend-item">
          <span className="badge slack">Slack</span>
        </span>
        <span className="legend-item">
          <span className="badge gmail">Gmail</span>
        </span>
      </div>
    </div>
  );
}

function HowTo() {
  return (
    <details className="panel howto">
      <summary>
        <span className="howto-icon">?</span> How to use this
      </summary>
      <ul className="howto-list">
        <li>
          <strong>Top list = what to handle.</strong> Sorted by AI priority. Drag the{" "}
          <span className="handle-inline">⠿</span> handle to reorder however you like.
        </li>
        <li>
          <strong>Click any task</strong> to read the full message, see the thread, and draft a
          reply with AI (nothing sends automatically — you copy it).
        </li>
        <li>
          <strong>Snooze</strong> hides a task until later, <strong>Done</strong> clears it, and{" "}
          <strong>Ignore</strong> dismisses it for good.
        </li>
        <li>
          <strong>FYI</strong> and <strong>Junk</strong> are tucked below — open them anytime. In a
          task you can move it between Needs&nbsp;reply / FYI / Junk.
        </li>
        <li>
          New texts, Slack messages, and emails show up on their own and get triaged within a couple
          minutes.
        </li>
      </ul>
    </details>
  );
}

function SortableTaskCard({
  task,
  onOpen,
  onDone,
}: {
  task: TaskRow;
  onOpen: () => void;
  onDone: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <TaskCard
      task={task}
      onOpen={onOpen}
      onDone={onDone}
      dragRef={setNodeRef}
      dragStyle={style}
      handleProps={{ ...attributes, ...listeners }}
    />
  );
}

function TaskCard({
  task,
  onOpen,
  onDone,
  dragRef,
  dragStyle,
  handleProps,
}: {
  task: TaskRow;
  onOpen: () => void;
  onDone: () => void;
  dragRef?: (el: HTMLElement | null) => void;
  dragStyle?: React.CSSProperties;
  handleProps?: React.HTMLAttributes<HTMLButtonElement>;
}) {
  const level = urgencyLevel(task.urgency);
  return (
    <article ref={dragRef} style={dragStyle} className={`tcard ${level}`}>
      {handleProps && (
        <button type="button" className="drag-handle" aria-label="Drag to reorder" {...handleProps}>
          ⠿
        </button>
      )}
      <button type="button" className="tcard-body" onClick={onOpen}>
        <div className="tcard-line">
          <h3 className="tcard-title">{task.title}</h3>
          {task.channel && <span className={`badge ${task.channel}`}>{task.channel}</span>}
        </div>
        {task.summary && <p className="tcard-summary">{task.summary}</p>}
        <div className="tcard-meta">
          <span className={`prio ${level}`}>{urgencyLabel(level)}</span>
          <span>{task.contacts?.display_name || "Unknown"}</span>
          <span>·</span>
          <span>{formatFreshness(task.created_at)}</span>
          {!task.triaged_at && <span className="triaging">triaging…</span>}
        </div>
      </button>
      <button type="button" className="tcard-done" title="Mark done" onClick={onDone}>
        ✓
      </button>
    </article>
  );
}

function CategoryBadge({ category }: { category: TaskCategory }) {
  const label = category === "needs_reply" ? "needs reply" : category === "fyi" ? "FYI" : "junk";
  return <span className={`badge cat-${category}`}>{label}</span>;
}

function TaskDrawer({
  task,
  onClose,
  onDone,
  onIgnore,
  onSnooze,
  onTag,
  onCategory,
}: {
  task: TaskRow;
  onClose: () => void;
  onDone: () => void;
  onIgnore: () => void;
  onSnooze: (until: Date) => void;
  onTag: (tag: ContactTag) => void;
  onCategory: (c: TaskCategory) => void;
}) {
  const [message, setMessage] = useState<MessageRow | null>(null);
  const [thread, setThread] = useState<MessageRow[]>([]);
  const [loadingMsg, setLoadingMsg] = useState(true);
  const [draft, setDraft] = useState("");
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
    if (error) return setDraftError(error.message);
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

  const cats: { key: TaskCategory; label: string }[] = [
    { key: "needs_reply", label: "Needs reply" },
    { key: "fyi", label: "FYI" },
    { key: "junk", label: "Junk" },
  ];

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="badges">
            {task.channel && <span className={`badge ${task.channel}`}>{task.channel}</span>}
            {task.category && <CategoryBadge category={task.category} />}
            {task.urgency != null && <span className="badge urgency">urgency {task.urgency}</span>}
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
          <h3>Classify</h3>
          <div className="seg">
            {cats.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`seg-btn ${task.category === c.key ? "active" : ""}`}
                onClick={() => onCategory(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
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
            <button
              type="button"
              className="chip-btn"
              onClick={() => void generateDraft()}
              disabled={drafting}
            >
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
    if (authError) return setError(authError.message);
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
