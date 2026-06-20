-- Phase 2 outreach: review link + daily owner summary config.
-- Run in Supabase SQL editor.
alter table clinics add column if not exists google_review_url text;     -- for review requests
alter table clinics add column if not exists owner_summary_phone text;   -- WhatsApp for daily summary (falls back to escalation_contact)
alter table clinics add column if not exists reactivation_days int default 90; -- lapsed-client recall window
alter table clients add column if not exists last_reactivated_at timestamptz;  -- dedup: don't spam recalls
-- Stripe deposits: amount to hold per booking (0/null = deposits off for this clinic)
alter table clinics add column if not exists deposit_zar int default 0;
-- track deposit state on bookings
alter table bookings add column if not exists deposit_status text;            -- null | 'requested' | 'paid'
