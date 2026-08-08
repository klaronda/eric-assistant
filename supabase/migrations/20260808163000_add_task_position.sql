-- Manual ordering for the priority list (drag-and-drop)
alter table public.tasks
  add column if not exists position double precision not null default 0;

-- Seed existing open/snoozed tasks from the AI urgency order (top = most urgent)
with ranked as (
  select id, row_number() over (order by urgency desc nulls last, created_at desc) as rn
  from public.tasks
  where status in ('open', 'snoozed')
)
update public.tasks t
set position = ranked.rn
from ranked
where t.id = ranked.id;

create index if not exists tasks_position_idx on public.tasks (position);

comment on column public.tasks.position is 'Manual sort order for the priority list; lower = higher. New tasks default to 0 (top).';
