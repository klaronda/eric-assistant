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
    -- Replace YOUR_GMAIL_INGEST_TOKEN with the live secret (do not commit real tokens)
    url := 'https://hyujjndlzbsntcdourkh.supabase.co/functions/v1/gmail-sync?token=YOUR_GMAIL_INGEST_TOKEN',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
