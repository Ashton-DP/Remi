-- Dashboard access control. The master gate is the DASHBOARD_TOKEN env var
-- (fail-closed: no token => dashboard disabled). Optionally give a clinic its
-- own scoped token so you can hand them a link to ONLY their dashboard.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table clinics add column if not exists dashboard_token text;
  -- optional per-clinic token; set to a long random value, share /dashboard/<id>?token=<value>
