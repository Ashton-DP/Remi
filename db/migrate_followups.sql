-- Unconverted-enquiry follow-up: mark when a one-time follow-up has been sent for
-- a conversation, so we never chase the same person twice.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table conversations add column if not exists followup_sent_at timestamptz;
