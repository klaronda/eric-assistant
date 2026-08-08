-- Gmail sync every 30 minutes via pg_cron + pg_net
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'gmail-sync-every-30-min';

select cron.schedule(
  'gmail-sync-every-30-min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://hyujjndlzbsntcdourkh.supabase.co/functions/v1/gmail-sync?token=cc7f7f734481ed5cae19c3d602e1d7df9a0a3908f2de0c7b',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
