-- Eric assistant: multi-channel request organizer

create extension if not exists "pgcrypto";

create type public.channel_type as enum ('quo', 'slack', 'gmail');
create type public.contact_tag as enum ('business', 'dump', 'unknown');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.task_status as enum ('open', 'snoozed', 'done', 'ignored');
create type public.draft_status as enum ('pending', 'approved', 'sent', 'discarded');

-- People (merged across phone / email / Slack)
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  tag public.contact_tag not null default 'unknown',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_tag_idx on public.contacts (tag);

-- Channel-specific identifiers for a contact
create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel public.channel_type not null,
  external_id text not null,
  label text,
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);

create index contact_identities_contact_id_idx
  on public.contact_identities (contact_id);

-- Normalized messages from Quo / Slack / Gmail
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  channel public.channel_type not null,
  direction public.message_direction not null,
  contact_id uuid references public.contacts (id) on delete set null,
  external_message_id text,
  external_thread_id text,
  from_identity text,
  to_identity text,
  subject text,
  body text not null default '',
  raw jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index messages_channel_external_message_id_uidx
  on public.messages (channel, external_message_id)
  where external_message_id is not null;

create index messages_received_at_idx on public.messages (received_at desc);
create index messages_contact_id_idx on public.messages (contact_id);
create index messages_thread_idx
  on public.messages (channel, external_thread_id);
create index messages_direction_received_idx
  on public.messages (direction, received_at desc);

-- Open work items derived from inbound requests
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts (id) on delete set null,
  source_message_id uuid references public.messages (id) on delete set null,
  channel public.channel_type,
  title text not null,
  summary text,
  urgency smallint check (urgency is null or (urgency between 1 and 10)),
  urgency_source text check (
    urgency_source is null
    or urgency_source in ('model', 'sender', 'manual', 'channel')
  ),
  status public.task_status not null default 'open',
  snooze_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index tasks_status_idx on public.tasks (status);
create index tasks_created_at_idx on public.tasks (created_at desc);
create index tasks_contact_id_idx on public.tasks (contact_id);
create index tasks_open_urgency_idx
  on public.tasks (urgency desc nulls last)
  where status = 'open';

-- AI drafts for Eric to approve (auto-send off for now)
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks (id) on delete set null,
  reply_to_message_id uuid references public.messages (id) on delete set null,
  channel public.channel_type not null,
  body text not null,
  status public.draft_status not null default 'pending',
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index drafts_status_idx on public.drafts (status);
create index drafts_task_id_idx on public.drafts (task_id);

-- updated_at helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

create trigger drafts_set_updated_at
  before update on public.drafts
  for each row execute function public.set_updated_at();

-- Lock down: service role (edge functions) bypasses RLS;
-- no anon/authenticated policies yet (single-user backend).
alter table public.contacts enable row level security;
alter table public.contact_identities enable row level security;
alter table public.messages enable row level security;
alter table public.tasks enable row level security;
alter table public.drafts enable row level security;

comment on table public.contacts is 'People Eric communicates with; tag drives dump vs organize.';
comment on table public.contact_identities is 'Phone, email, or Slack user id linked to a contact.';
comment on table public.messages is 'Normalized Quo / Slack / Gmail messages.';
comment on table public.tasks is 'Open requests extracted from inbound messages.';
comment on table public.drafts is 'AI reply drafts pending Eric approval.';
