export type Channel = "quo" | "slack" | "gmail";
export type ContactTag = "business" | "dump" | "unknown";
export type TaskStatus = "open" | "snoozed" | "done" | "ignored";
export type TaskCategory = "needs_reply" | "fyi" | "junk";

export type TaskRow = {
  id: string;
  title: string;
  summary: string | null;
  channel: Channel | null;
  urgency: number | null;
  category: TaskCategory | null;
  triaged_at: string | null;
  status: TaskStatus;
  snooze_until: string | null;
  position: number;
  created_at: string;
  contact_id: string | null;
  source_message_id: string | null;
  contacts: {
    id: string;
    display_name: string | null;
    tag: ContactTag;
  } | null;
};

export type MessageRow = {
  id: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  from_identity: string | null;
  to_identity: string | null;
  external_thread_id: string | null;
  received_at: string;
};

export type ChannelStatus = {
  channel: Channel;
  label: string;
  lastAt: string | null;
  detail: string;
  ok: boolean;
};

export type Database = {
  public: {
    Tables: {
      tasks: {
        Row: {
          id: string;
          title: string;
          summary: string | null;
          channel: Channel | null;
          urgency: number | null;
          status: TaskStatus;
          created_at: string;
          contact_id: string | null;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      contacts: {
        Row: {
          id: string;
          display_name: string | null;
          tag: ContactTag;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      messages: {
        Row: {
          id: string;
          channel: Channel;
          created_at: string;
          received_at: string;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      sync_state: {
        Row: {
          key: string;
          value: Record<string, unknown>;
          updated_at: string;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
    };
  };
};
