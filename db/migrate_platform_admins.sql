-- Platform admins: Remi operators who can see ALL clinics (the operator/god-view),
-- not scoped to a single clinic like clinic_users. Add yourself with
-- scripts/addPlatformAdmin.ts (or insert your auth user_id here).
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';
create table if not exists platform_admins (
  user_id uuid primary key,
  created_at timestamptz default now()
);
notify pgrst, 'reload schema';
