-- Dashboard accounts: link Supabase Auth users to clinics with a role, so a
-- subscriber can log into the master dashboard and only see their own clinic.
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';
-- (Supabase Auth must be enabled — it is by default; email provider on.)

create table if not exists clinic_users (
  user_id    uuid not null references auth.users(id) on delete cascade,
  clinic_id  uuid not null references clinics(id) on delete cascade,
  role       text not null default 'staff',  -- owner | admin | staff
  created_at timestamptz default now(),
  primary key (user_id, clinic_id)
);
create index if not exists clinic_users_user_idx on clinic_users (user_id);

-- Defence in depth: a user can read their own membership rows when querying with
-- their own JWT. (The dashboard API uses the service key + explicit clinic
-- scoping as the primary guard; this RLS is a backstop.)
alter table clinic_users enable row level security;
do $$ begin
  create policy clinic_users_self_select on clinic_users for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
