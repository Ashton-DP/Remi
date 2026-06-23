-- Invoice sources: auto-import overdue invoices from Xero / QuickBooks / Sage /
-- a published Google Sheet. Adds the connection state to clinics and an
-- external_id (provider's invoice id) for reconciliation.
-- Run in the Supabase SQL editor, then: notify pgrst, 'reload schema';

-- Which source a clinic pulls invoices from + its OAuth tokens / config.
alter table clinics add column if not exists invoice_source        text;   -- xero | quickbooks | sage | gsheet
alter table clinics add column if not exists invoice_source_tokens jsonb;  -- OAuth token set
alter table clinics add column if not exists invoice_source_config jsonb;  -- {xero_tenant_id|realm_id|sage_business_id|sheet_url}

-- Provider's own invoice id, so a synced invoice can be matched + reconciled
-- (marked paid) when it clears upstream. (invoice_number stays the upsert key.)
alter table invoices add column if not exists external_id text;
create index if not exists invoices_source_ext_idx on invoices (clinic_id, source, external_id);

notify pgrst, 'reload schema';
