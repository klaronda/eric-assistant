export type Channel = "quo" | "slack" | "gmail";
export type ContactTag = "business" | "dump" | "unknown";
export type TaskStatus = "open" | "snoozed" | "done" | "ignored";

export type TaskRow = {
  id: string;
  title: string;
  summary: string | null;
  channel: Channel | null;
  urgency: number | null;
  status: TaskStatus;
  created_at: string;
  contact_id: string | null;
  contacts: {
    id: string;
    display_name: string | null;
    tag: ContactTag;
  } | null;
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
