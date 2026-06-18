-- Remi MVP schema (Supabase / Postgres). Run in the Supabase SQL editor.
-- See docs/SPEC.md §4 for the data model.

create extension if not exists pgcrypto;

create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  twilio_number text,                -- E.164 phone number this clinic owns (+27215551234)
  whatsapp_number text,
  timezone text default 'Africa/Johannesburg',
  hours_json jsonb,                 -- {"mon":[["09:00","17:00"]], ...}
  calendar_ref text,                -- google calendar id (optional mirror of env)
  services_json jsonb,              -- [{"service","price_zar","duration_min"}]
  faq_json jsonb,                   -- [{"q","a"}]
  tone_notes text,
  escalation_contact text,          -- owner WhatsApp/phone for handoffs
  avg_new_client_value_zar int,
  created_at timestamptz default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  name text,
  phone text not null,
  consent_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  unique (clinic_id, phone)
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  client_id uuid references clients(id),
  channel text,                     -- 'whatsapp' | 'missed_call'
  status text,                      -- 'open' | 'booked' | 'escalated' | 'closed'
  last_message_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id),
  direction text,                   -- 'in' | 'out'
  body text,
  meta jsonb,
  created_at timestamptz default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  client_id uuid references clients(id),
  service text,
  start_at timestamptz,
  end_at timestamptz,
  status text,                      -- 'pending'|'confirmed'|'cancelled'|'no_show'|'completed'
  source text,                      -- 'whatsapp'|'missed_call'|'manual'
  after_hours boolean default false,
  calendar_event_id text,
  created_at timestamptz default now()
);

create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  client_id uuid references clients(id),
  service text,
  preferred_window text,
  status text,                      -- 'waiting'|'offered'|'filled'|'expired'
  created_at timestamptz default now()
);

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id),
  kind text,                        -- 'confirm'|'48h'|'24h'|'2h'
  scheduled_for timestamptz,
  sent_at timestamptz,
  status text,                      -- 'pending'|'sent'|'confirmed'|'reschedule'|'no_response'
  response text
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  booking_id uuid references bookings(id),
  type text,                        -- 'enquiry_received'|'missed_call_recovered'|'booking_created'|'slot_backfilled'|'no_show_prevented'
  value_zar int default 0,
  created_at timestamptz default now()
);

create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id),
  reason text,
  summary text,
  status text,                      -- 'open'|'resolved'
  created_at timestamptz default now()
);
