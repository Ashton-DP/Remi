-- Onboarding wizard + per-clinic WhatsApp number

alter table clinics
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists whatsapp_number text,
  add column if not exists whatsapp_pending boolean default false;

-- Index so getClinicByWhatsAppNumber is fast
create index if not exists clinics_whatsapp_number_idx on clinics (whatsapp_number);
