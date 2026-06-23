-- Digital patient intake form. Stores the submitted form on the client record so
-- the clinic has the patient's details/history before the visit.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table clients add column if not exists intake_json jsonb;
alter table clients add column if not exists intake_submitted_at timestamptz;
