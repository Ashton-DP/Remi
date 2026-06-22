// Create (or refresh) a demo "sandbox" clinic you can show prospects from your
// phone anytime — services, hours, FAQs all set. Idempotent: re-running updates
// the same demo clinic instead of creating duplicates.
// Run: node --env-file=.env scripts/seedDemoClinic.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const supabase = createClient(url, key);

const NAME = 'Remi Demo Clinic (Sandbox)';
const clinic = {
  name: NAME,
  timezone: 'Africa/Johannesburg',
  hours_json: {
    mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']],
    thu: [['09:00', '17:00']], fri: [['09:00', '16:00']],
  },
  services_json: [
    { service: 'Botox consultation', price_zar: 0, duration_min: 30 },
    { service: 'Botox treatment', price_zar: 2500, duration_min: 45 },
    { service: 'Dermal filler', price_zar: 3500, duration_min: 60 },
    { service: 'Skin rejuvenation facial', price_zar: 1200, duration_min: 60 },
  ],
  faq_json: [
    { q: 'Where are you located?', a: 'This is a demo clinic for showcasing Remi.' },
    { q: 'Do you offer free consultations?', a: 'Yes — Botox consultations are free.' },
    { q: 'Is there parking?', a: 'Yes, free parking outside.' },
  ],
  tone_notes: 'Friendly, reassuring; premium but down-to-earth.',
  avg_new_client_value_zar: 3000,
  booking_provider: 'google',
};

async function main() {
  const { data: existing } = await supabase.from('clinics').select('id').eq('name', NAME).maybeSingle();
  let id;
  if (existing?.id) {
    await supabase.from('clinics').update(clinic).eq('id', existing.id);
    id = existing.id;
    console.log(`Updated existing demo clinic ${id}`);
  } else {
    const { data, error } = await supabase.from('clinics').insert(clinic).select('id').single();
    if (error) throw new Error(error.message);
    id = data.id;
    console.log(`Created demo clinic ${id}`);
  }

  const token = process.env.DASHBOARD_TOKEN;
  const base = 'https://www.remireception.com';
  console.log('\nDemo clinic ready:');
  console.log(`  id:        ${id}`);
  console.log(`  dashboard: ${base}/dashboard/${id}${token ? `?token=${encodeURIComponent(token)}` : ' (set DASHBOARD_TOKEN to view)'}`);
  console.log(`  tip: set DEFAULT_CLINIC_ID=${id} in .env to point the sandbox agent at it.`);
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
