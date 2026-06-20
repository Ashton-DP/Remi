-- Provider-agnostic booking: let each clinic declare which booking system Remi
-- should read/write. Defaults to Google Calendar (the universal fallback), so
-- existing clinics keep working with no change.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table clinics add column if not exists booking_provider text default 'google';
  -- 'google' | 'acuity' | 'cliniko' | 'nookal' | (planned) 'fresha' | 'goodx'
alter table clinics add column if not exists google_calendar_id text;
  -- optional: a dedicated calendar id for this clinic; falls back to GOOGLE_CALENDAR_ID

-- API-based providers. Set only the block for the clinic's chosen booking_provider.
-- Per-SERVICE id mappings live inside services_json entries (not columns) — see
-- docs/booking-providers.md. credentials are per-clinic and live here:

-- Acuity Scheduling
alter table clinics add column if not exists acuity_user_id text;
alter table clinics add column if not exists acuity_api_key text;
alter table clinics add column if not exists acuity_calendar_id text;   -- default calendar (optional)

-- Cliniko (api key contains the shard suffix, e.g. "...-au1")
alter table clinics add column if not exists cliniko_api_key text;
alter table clinics add column if not exists cliniko_business_id text;
alter table clinics add column if not exists cliniko_practitioner_id text;  -- default practitioner

-- Nookal (api key maps to one location)
alter table clinics add column if not exists nookal_api_key text;
alter table clinics add column if not exists nookal_location_id text;
alter table clinics add column if not exists nookal_practitioner_id text;   -- default practitioner
