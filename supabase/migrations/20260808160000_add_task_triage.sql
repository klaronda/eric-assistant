-- AI triage support: category + triage bookkeeping on tasks

alter table public.tasks
  add column if not exists category text
  check (category is null or category in ('needs_reply', 'fyi', 'junk'));

alter table public.tasks
  add column if not exists triaged_at timestamptz;

-- Fast lookup for the triage worker: open tasks not yet classified
create index if not exists tasks_untriaged_idx
  on public.tasks (created_at)
  where triaged_at is null and status = 'open';

-- Group/sort helper for the dashboard
create index if not exists tasks_open_category_urgency_idx
  on public.tasks (category, urgency desc nulls last)
  where status = 'open';

comment on column public.tasks.category is 'AI triage bucket: needs_reply | fyi | junk.';
comment on column public.tasks.triaged_at is 'When the AI triage worker last classified this task.';
