-- Idempotency store for inbound webhook retries. Twilio re-delivers a webhook if
-- our response is slow or returns 5xx; without dedup that double-books / double-
-- replies. We record each handled message SID and skip repeats.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
create table if not exists processed_messages (
  sid text primary key,
  created_at timestamptz not null default now()
);
-- Optional housekeeping: old rows can be pruned periodically, e.g.
--   delete from processed_messages where created_at < now() - interval '30 days';
