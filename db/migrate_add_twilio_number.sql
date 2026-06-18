-- Run this in the Supabase SQL editor if you already have the schema
-- and need to add the twilio_number column to an existing clinics table.
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS twilio_number text;
