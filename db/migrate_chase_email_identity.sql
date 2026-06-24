-- Per-clinic email sender identity for invoice chasing. Chase emails go out AS
-- THE CLINIC, not as Remi: the clinic's name is the display name, replies route
-- to the clinic, and (optionally) the From address is the clinic's own verified
-- domain for full white-label.
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';

-- The clinic's own From address — only use once their domain is verified in the
-- email provider (Resend). When null, Remi sends from its verified domain with
-- the clinic's NAME as display + chase_reply_to as Reply-To.
alter table clinics add column if not exists chase_from_email text;

-- Where replies to chase emails should go (the clinic's inbox).
alter table clinics add column if not exists chase_reply_to text;

notify pgrst, 'reload schema';
