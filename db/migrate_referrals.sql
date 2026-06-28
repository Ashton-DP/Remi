-- Referral attribution. Each client gets a personal referral code; when a friend
-- mentions it on first contact (via the prefilled WhatsApp share link), we record
-- the referral and attribute it. The owner sees who referred whom and rewards both.

alter table clients add column if not exists referral_code text;
create unique index if not exists clients_referral_code_idx
  on clients (referral_code) where referral_code is not null;

create table if not exists referrals (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid not null references clinics(id) on delete cascade,
  referrer_client_id  uuid not null references clients(id) on delete cascade,
  referred_client_id  uuid references clients(id) on delete set null,
  referred_phone      text,
  code                text not null,
  reward              text,                      -- snapshot of the reward terms at capture
  status              text not null default 'pending'
                        check (status in ('pending','booked','rewarded')),
  created_at          timestamptz not null default now(),
  booked_at           timestamptz,
  rewarded_at         timestamptz
);

-- One referral per referred client (the friend) — first attribution wins.
create unique index if not exists referrals_referred_idx
  on referrals (clinic_id, referred_client_id) where referred_client_id is not null;
create index if not exists referrals_clinic_status_idx on referrals (clinic_id, status);
