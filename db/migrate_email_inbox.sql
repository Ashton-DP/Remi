-- Per-clinic email inbox: Remi reads + replies to booking emails on the clinic's
-- OWN mailbox via IMAP (read) + SMTP (send), the same "operate their existing
-- channel" model as WhatsApp. email_inbox holds the connection config:
--   { imap_host, imap_port, smtp_host, smtp_port, user, pass, from_name, enabled }
-- pass is the clinic's app-password (entered by the clinic in the dashboard,
-- never by support). Treat as a secret.
alter table clinics add column if not exists email_inbox jsonb;

-- Clients can now be identified by email (previously phone-only), so an email
-- thread maps to the same client/conversation model as WhatsApp.
alter table clients add column if not exists email text;
create index if not exists clients_clinic_email_idx on clients (clinic_id, email);

-- Reload PostgREST schema cache so selects on the new columns don't 400.
notify pgrst, 'reload schema';
