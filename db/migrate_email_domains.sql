-- White-label email sending domains (Resend Domains API). Each clinic can send
-- chase emails from its OWN domain once the DNS is verified. Until then, Remi
-- sends send-on-behalf (clinic name + reply-to on Remi's verified domain).
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';

alter table clinics add column if not exists email_domain         text;   -- the clinic's sending domain
alter table clinics add column if not exists email_domain_id      text;   -- Resend domain id
alter table clinics add column if not exists email_domain_status  text;   -- pending | verified | failed | none
alter table clinics add column if not exists email_domain_records jsonb;  -- DNS records the clinic must add

notify pgrst, 'reload schema';
