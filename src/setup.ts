/**
 * One-shot setup: seeds the demo clinic (if none exists) and writes
 * DEFAULT_CLINIC_ID into .env. Run with: npm run setup
 * Requires the tables to exist — run db/schema.sql in the Supabase SQL editor first.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { supabase } from './lib/supabase';

const DEMO_CLINIC = {
  name: 'Demo Aesthetics (George)',
  timezone: 'Africa/Johannesburg',
  hours_json: {
    mon: [['09:00', '17:00']],
    tue: [['09:00', '17:00']],
    wed: [['09:00', '17:00']],
    thu: [['09:00', '17:00']],
    fri: [['09:00', '16:00']],
  },
  services_json: [
    { service: 'Botox consultation', price_zar: 0, duration_min: 30 },
    { service: 'Botox treatment', price_zar: 2500, duration_min: 45 },
    { service: 'Dermal filler', price_zar: 3500, duration_min: 60 },
    { service: 'Skin rejuvenation facial', price_zar: 1200, duration_min: 60 },
  ],
  faq_json: [
    { q: 'Where are you located?', a: '8 St Johns Street, George.' },
    { q: 'Do you offer free consultations?', a: 'Yes, Botox consultations are free.' },
    { q: 'Is there parking?', a: 'Yes, free parking outside the clinic.' },
  ],
  tone_notes: 'Friendly and reassuring; premium but down-to-earth.',
  escalation_contact: 'whatsapp:+27000000000',
  avg_new_client_value_zar: 3000,
};

function writeEnvClinicId(id: string) {
  const p = path.resolve(process.cwd(), '.env');
  let txt = fs.readFileSync(p, 'utf8');
  if (/^DEFAULT_CLINIC_ID=.*$/m.test(txt)) {
    txt = txt.replace(/^DEFAULT_CLINIC_ID=.*$/m, `DEFAULT_CLINIC_ID=${id}`);
  } else {
    txt += `\nDEFAULT_CLINIC_ID=${id}\n`;
  }
  fs.writeFileSync(p, txt);
}

async function main() {
  const { data, error } = await supabase.from('clinics').select('id,name').limit(1);

  if (error) {
    const code = (error as any).code;
    if (
      code === '42P01' ||
      code === 'PGRST205' ||
      /does not exist|schema cache|could not find the table/i.test(error.message)
    ) {
      console.error(
        '✗ Tables not found.\n  Open Supabase → SQL Editor → paste db/schema.sql → Run, then re-run: npm run setup',
      );
    } else {
      console.error('✗ Supabase connection error:', error.message);
    }
    process.exit(1);
  }

  let clinic = data?.[0];
  if (!clinic) {
    const ins = await supabase.from('clinics').insert(DEMO_CLINIC).select('id,name').single();
    if (ins.error || !ins.data) {
      console.error('✗ Could not seed clinic:', ins.error?.message);
      process.exit(1);
    }
    clinic = ins.data;
    console.log(`✓ Seeded demo clinic: ${clinic.name}`);
  } else {
    console.log(`✓ Found existing clinic: ${clinic.name}`);
  }

  writeEnvClinicId(clinic.id);
  console.log(`✓ Wrote DEFAULT_CLINIC_ID=${clinic.id} to .env`);
  console.log('\nReady. Run:  npm run chat\n');
}

main();
