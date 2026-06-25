-- Manual waitlist ordering: a receptionist can shuffle who's next.
-- position ascending = higher priority. Null sorts last (legacy/AI-added rows).
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table waitlist add column if not exists position int;
notify pgrst, 'reload schema';
