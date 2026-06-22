-- Booking idempotency backstop: prevent two CONFIRMED bookings for the same
-- clinic + client + service + start time. The app already checks for a duplicate
-- before creating (findConfirmedBooking), but this partial unique index makes
-- double-booking impossible even under a race / fail-open dedup.
-- Run in Supabase SQL editor, then: notify pgrst, 'reload schema';
create unique index if not exists bookings_no_dup_confirmed
  on bookings (clinic_id, client_id, service, start_at)
  where status = 'confirmed';
