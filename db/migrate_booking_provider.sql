-- Provider-agnostic booking: let each clinic declare which booking system Remi
-- should read/write. Defaults to Google Calendar (the universal fallback), so
-- existing clinics keep working with no change.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
alter table clinics add column if not exists booking_provider text default 'google';
  -- 'google' | (future) 'fresha' | 'acuity' | 'nookal' | 'cliniko' | 'goodx'
alter table clinics add column if not exists google_calendar_id text;
  -- optional: a dedicated calendar id for this clinic; falls back to GOOGLE_CALENDAR_ID
