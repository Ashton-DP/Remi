-- Durable once-per-period markers for the scheduler's daily/brief/chase/monthly
-- jobs. Replaces in-memory guards that reset on restart (causing duplicate owner
-- briefs / chases) and don't coordinate across multiple instances (N× sends).
-- A job claims its key with INSERT ... ON CONFLICT DO NOTHING; only the winner runs.
create table if not exists scheduler_runs (
  key     text primary key,
  ran_at  timestamptz not null default now()
);
