-- Dashboard tier per clinic. The plan a clinic is on decides which dashboard
-- they see on sign-in (basic = appointments only; complete = full command centre).
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';
-- Default 'complete' so existing clinics keep the full dashboard.
alter table clinics add column if not exists plan text default 'complete';
notify pgrst, 'reload schema';
