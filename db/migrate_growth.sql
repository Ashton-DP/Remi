-- Remi Growth — owner-guided campaigns. Remi detects an opportunity and proposes
-- a campaign; the owner approves the specifics (discount, reward, target list)
-- before anything goes out. Remi never exceeds the owner's guardrails.

-- Per-clinic guardrails + per-type config. Shape (all optional, sensible defaults):
-- {
--   "max_discount_pct": 20,
--   "gap_fill":  { "enabled": true,  "approval": "ask" },
--   "winback":   { "enabled": true,  "approval": "ask", "cadence_buffer_days": 14 },
--   "referral":  { "enabled": false, "reward": "R50 off for both of you" },
--   "review":    { "enabled": true },
--   "offpeak":   { "enabled": false, "approval": "ask", "windows": "Tue/Wed mornings" }
-- }
-- approval: "ask" = always create a pending proposal for the owner; "auto" = act
-- within guardrails without waiting (still logged as a proposal, status 'sent').
alter table clinics add column if not exists growth_settings jsonb;

create table if not exists growth_proposals (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references clinics(id) on delete cascade,
  type         text not null check (type in ('gap_fill','winback','referral','review','offpeak')),
  status       text not null default 'pending'
                 check (status in ('pending','approved','declined','sent','expired')),
  title        text not null,                 -- short owner-facing summary
  detail       text,                          -- longer explanation of what Remi will do
  payload      jsonb not null default '{}'::jsonb,  -- Remi's suggested specifics (targets, slots, suggested_discount_pct, message)
  owner_input  jsonb,                         -- owner's chosen specifics (discount_pct, reward, excluded ids)
  results      jsonb,                         -- outcome after execution ({ sent, claimed, ... })
  decided_by   text,                          -- user id/email who approved/declined
  decided_at   timestamptz,
  sent_at      timestamptz,
  expires_at   timestamptz,                   -- proposal goes stale (e.g. a gap-fill for a date that passed)
  created_at   timestamptz not null default now()
);

create index if not exists growth_proposals_clinic_status_idx on growth_proposals (clinic_id, status);
create index if not exists growth_proposals_type_idx on growth_proposals (clinic_id, type, created_at desc);
