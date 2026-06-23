-- Free-text clinic knowledge base for the AI to answer common questions
-- (location, parking, payment/medical aid, what to expect, policies).
-- Also a default treatment-prep note used when a service has none.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table clinics add column if not exists knowledge text;
alter table clinics add column if not exists default_prep text;
