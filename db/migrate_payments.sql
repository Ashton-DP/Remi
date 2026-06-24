-- Payment links in chase messages. Each clinic brings its own payment provider
-- and credentials so customers can pay an overdue invoice in one tap.
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';

-- 'payfast' | 'paystack' | 'link' | null
alter table clinics add column if not exists payment_provider text;
-- Provider credentials / link, e.g.
--   { "payfast":  { "merchant_id":"...", "merchant_key":"...", "passphrase":"..." } }
--   { "paystack": { "secret_key":"sk_live_..." } }
--   { "link":     { "url":"https://pay.yoco.com/..." } }
alter table clinics add column if not exists payment_config jsonb;

notify pgrst, 'reload schema';
