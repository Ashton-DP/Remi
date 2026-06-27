-- Quick wins: a shared office to-do list + message-taking, and quick expense
-- logging. Tasks can be created by staff ("add task: order gloves"), by clients
-- (Remi takes a message — "ask Dr X to call me"), from the dashboard, or the
-- Ask-Remi copilot. The receptionist just clears the list.

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id) on delete cascade,
  title       text not null,
  note        text,
  assignee    text,                       -- free-text "who" (e.g. "Dr X") or null
  due_at      timestamptz,
  status      text default 'open',        -- open | done
  source      text default 'dashboard',   -- whatsapp-staff | whatsapp-client | dashboard | copilot
  created_at  timestamptz default now(),
  done_at     timestamptz
);
create index if not exists tasks_clinic_status_idx on tasks (clinic_id, status);

create table if not exists expenses (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id) on delete cascade,
  amount_zar  numeric not null,
  description text,
  category    text,
  logged_by   text,
  created_at  timestamptz default now()
);
create index if not exists expenses_clinic_idx on expenses (clinic_id, created_at);

notify pgrst, 'reload schema';
