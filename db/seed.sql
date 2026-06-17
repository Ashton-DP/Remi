-- Demo clinic for sandbox testing. Run after schema.sql, then copy the printed
-- id into DEFAULT_CLINIC_ID in your .env.

insert into clinics (name, timezone, hours_json, services_json, faq_json, tone_notes, escalation_contact, avg_new_client_value_zar)
values (
  'Demo Aesthetics (George)',
  'Africa/Johannesburg',
  '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","16:00"]]}',
  '[
    {"service":"Botox consultation","price_zar":0,"duration_min":30},
    {"service":"Botox treatment","price_zar":2500,"duration_min":45},
    {"service":"Dermal filler","price_zar":3500,"duration_min":60},
    {"service":"Skin rejuvenation facial","price_zar":1200,"duration_min":60}
  ]',
  '[
    {"q":"Where are you located?","a":"8 St Johns Street, George."},
    {"q":"Do you offer free consultations?","a":"Yes, Botox consultations are free."},
    {"q":"Is there parking?","a":"Yes, free parking outside the clinic."}
  ]',
  'Friendly and reassuring; this is a premium but down-to-earth clinic.',
  'whatsapp:+27000000000',
  3000
)
returning id;
