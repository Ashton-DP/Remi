-- Team Ops: Remi runs the staff back-office. Staff are the workforce, identified
-- by PHONE so Remi recognises them on WhatsApp/SMS and switches to "staff mode"
-- (clock in/out, leave) instead of the client booking brain. Distinct from
-- clinic_users (dashboard logins) — a staff member may have no dashboard account.

create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id) on delete cascade,
  name        text not null,
  phone       text,                       -- E.164; how Remi recognises them
  role        text default 'practitioner',-- practitioner | admin | owner
  pay_rate    numeric,                    -- optional, for payroll export
  active      boolean default true,
  created_at  timestamptz default now()
);
create index if not exists staff_clinic_phone_idx on staff (clinic_id, phone);

create table if not exists time_entries (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  clinic_id   uuid not null references clinics(id) on delete cascade,
  clock_in    timestamptz not null default now(),
  clock_out   timestamptz,                -- null = still clocked in
  source      text default 'whatsapp',    -- whatsapp | dashboard
  note        text,
  created_at  timestamptz default now()
);
create index if not exists time_entries_staff_idx on time_entries (staff_id, clock_in);
-- One open entry per staff member at a time (partial unique index).
create unique index if not exists time_entries_one_open_idx
  on time_entries (staff_id) where clock_out is null;

create table if not exists leave_requests (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  clinic_id   uuid not null references clinics(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  type        text default 'annual',      -- annual | sick | unpaid
  reason      text,
  status      text default 'pending',     -- pending | approved | declined
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz default now()
);
create index if not exists leave_requests_clinic_status_idx on leave_requests (clinic_id, status);

notify pgrst, 'reload schema';
