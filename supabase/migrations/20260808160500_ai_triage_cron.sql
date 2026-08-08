-- Run AI triage every 2 minutes via pg_cron + pg_net
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'ai-triage-every-2-min';

select cron.schedule(
  'ai-triage-every-2-min',
  '*/2 * * * *',
  $$
  select net.http_post(
    -- Replace YOUR_AI_INGEST_TOKEN with the live secret (do not commit real tokens)
    url := 'https://hyujjndlzbsntcdourkh.supabase.co/functions/v1/ai-triage?token=YOUR_AI_INGEST_TOKEN',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);
