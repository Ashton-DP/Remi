-- Module 3: Client OS — packages, memberships, richer client profiles

-- ─── Richer client profile ────────────────────────────────────────────────────
alter table clients
  add column if not exists notes         text,
  add column if not exists preferences   text,        -- e.g. "prefers morning slots, no deep tissue"
  add column if not exists allergies     text,        -- free-text clinical note
  add column if not exists tags          text[],      -- e.g. ['vip','new','referred']
  add column if not exists birthday      date,
  add column if not exists anniversary   date;        -- e.g. wedding or loyalty anniversary

-- ─── Packages ─────────────────────────────────────────────────────────────────
create table if not exists packages (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references clinics(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete cascade,
  name             text not null,                     -- e.g. "10-session massage bundle"
  sessions_total   integer not null check (sessions_total > 0),
  sessions_used    integer not null default 0 check (sessions_used >= 0),
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists packages_clinic_client_idx on packages (clinic_id, client_id);

-- ─── Memberships ──────────────────────────────────────────────────────────────
create table if not exists memberships (
  id                      uuid primary key default gen_random_uuid(),
  clinic_id               uuid not null references clinics(id) on delete cascade,
  client_id               uuid not null references clients(id) on delete cascade,
  plan_name               text not null,              -- e.g. "Monthly Wellness Plan"
  amount_zar              numeric,                    -- recurring charge per interval
  billing_interval        text default 'month'        -- 'month' | 'year' (interval is a reserved word)
                            check (billing_interval in ('month','year')),
  provider                text                        -- 'stripe' | 'payfast' | 'paystack'
                            check (provider in ('stripe','payfast','paystack')),
  external_subscription_id text,                      -- provider's subscription id / token
  status                  text not null default 'pending'
                            check (status in ('pending','active','paused','cancelled','past_due')),
  renews_at               timestamptz,
  created_at              timestamptz not null default now()
);

create index if not exists memberships_clinic_client_idx on memberships (clinic_id, client_id);
create index if not exists memberships_external_sub_idx  on memberships (external_subscription_id)
  where external_subscription_id is not null;

-- ─── Atomic package decrement RPC ─────────────────────────────────────────────
create or replace function increment_package_sessions_used(pkg_id uuid)
returns void language sql security definer as $$
  update packages
  set sessions_used = sessions_used + 1
  where id = pkg_id
    and sessions_used < sessions_total;
$$;
