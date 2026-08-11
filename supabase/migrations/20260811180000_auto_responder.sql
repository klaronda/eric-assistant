-- Auto-responder: settings (singleton) + sent-response log

create type public.autoresponder_preset as enum (
  'on_location',
  'client_meetings',
  'deep_work',
  'ooo',
  'custom'
);

-- Singleton settings row (id is always true)
create table public.autoresponder_settings (
  id boolean primary key default true,
  enabled boolean not null default false,
  preset public.autoresponder_preset not null default 'on_location',
  custom_message text,
  respond_quo boolean not null default true,
  respond_slack boolean not null default true,
  cooldown_hours integer not null default 4 check (cooldown_hours between 0 and 168),
  updated_at timestamptz not null default now(),
  constraint autoresponder_settings_singleton check (id)
);

insert into public.autoresponder_settings (id) values (true)
on conflict (id) do nothing;

create trigger autoresponder_settings_set_updated_at
  before update on public.autoresponder_settings
  for each row execute function public.set_updated_at();

-- Log of every auto-reply we sent (also drives the once-per-person cooldown)
create table public.auto_responses (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts (id) on delete set null,
  channel public.channel_type not null,
  preset public.autoresponder_preset,
  inbound_message_id uuid references public.messages (id) on delete set null,
  reply_message_id uuid references public.messages (id) on delete set null,
  body text not null default '',
  created_at timestamptz not null default now()
);

create index auto_responses_contact_channel_idx
  on public.auto_responses (contact_id, channel, created_at desc);
create index auto_responses_created_at_idx
  on public.auto_responses (created_at desc);

-- RLS: authenticated dashboard user manages settings; edge functions use the
-- service role and bypass RLS.
alter table public.autoresponder_settings enable row level security;
alter table public.auto_responses enable row level security;

create policy authenticated_all_autoresponder_settings
  on public.autoresponder_settings for all
  to authenticated using (true) with check (true);

create policy authenticated_read_auto_responses
  on public.auto_responses for select
  to authenticated using (true);

comment on table public.autoresponder_settings is
  'Single-row config for the auto-responder (off by default).';
comment on table public.auto_responses is
  'Log of auto-replies sent; also enforces once-per-person cooldown.';
