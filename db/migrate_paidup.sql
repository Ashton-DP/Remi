-- Invoice chasing (PaidUp engine ported into Remi).
-- Adds: invoices, invoice_chases (send log), suppressions (opt-outs),
-- plus per-clinic kill switch + cadence override.
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';

-- Per-clinic chase controls
alter table clinics add column if not exists chasing_paused boolean default false;
alter table clinics add column if not exists chase_cadence jsonb; -- {stage1,stage2,stage3,cooldown}; null = defaults

-- Invoices to chase. Idempotent on (clinic_id, invoice_number) so CSV re-imports
-- update contact/amount/date without resetting chase progress.
create table if not exists invoices (
  id             uuid primary key default gen_random_uuid(),
  clinic_id      uuid not null references clinics(id) on delete cascade,
  client_id      uuid references clients(id) on delete set null,
  invoice_number text not null,
  contact_name   text,
  contact_phone  text,
  contact_email  text,
  amount_due     numeric not null,
  currency       text default 'ZAR',
  due_date       date not null,
  status         text default 'overdue',   -- overdue | paid
  chase_stage    int default 0,            -- 0=none, 1=friendly, 2=firm, 3=final
  last_chased_at timestamptz,
  paid_at        timestamptz,
  snoozed_until  timestamptz,
  disputed       boolean default false,
  source         text default 'csv',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (clinic_id, invoice_number)
);
create index if not exists invoices_chase_idx on invoices (clinic_id, status, disputed, due_date);

-- One row per chase message sent (audit trail).
create table if not exists invoice_chases (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  clinic_id  uuid not null references clinics(id) on delete cascade,
  stage      int not null,
  channel    text not null,   -- whatsapp | sms | email
  recipient  text not null,
  body       text,
  created_at timestamptz default now()
);
create index if not exists invoice_chases_invoice_idx on invoice_chases (invoice_id);

-- Opt-out suppression list (honour STOP / do-not-contact), per clinic + channel.
create table if not exists suppressions (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  channel    text not null,   -- whatsapp | sms | email
  identifier text not null,   -- phoneKey (last 9 digits) or lowercased email
  reason     text,
  created_at timestamptz default now(),
  unique (clinic_id, channel, identifier)
);
