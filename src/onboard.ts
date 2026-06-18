/**
 * Interactive CLI to onboard a new clinic into Remi.
 * Run with: npm run onboard
 */
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { config } from './config';
import { supabase } from './lib/supabase';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (q: string, fallback = ''): Promise<string> =>
  new Promise((res) =>
    rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `, (ans) =>
      res(ans.trim() || fallback),
    ),
  );

const askNum = async (q: string, fallback: number): Promise<number> => {
  const v = await ask(q, String(fallback));
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
};

async function main() {
  console.log('\n🏥  Remi — New clinic onboarding\n');

  const name = await ask('Clinic name');
  const twilioNumber = await ask('Twilio phone number (E.164, e.g. +27215551234) — leave blank to set later', '');
  const timezone = await ask('Timezone', 'Africa/Johannesburg');
  const avgValue = await askNum('Average new client value (ZAR)', 3000);
  const escalationContact = await ask('Owner WhatsApp for escalations (e.g. whatsapp:+27821234567)', '');
  const toneNotes = await ask('Tone notes (optional)', '');

  // Opening hours
  console.log('\nOpening hours — enter times as HH:MM-HH:MM, or "closed":');
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const dayLabels: Record<string, string> = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
  };
  const hours: Record<string, string[][]> = {};
  for (const d of days) {
    const defaultHours = ['sat', 'sun'].includes(d) ? 'closed' : '09:00-17:00';
    const input = await ask(`  ${dayLabels[d]}`, defaultHours);
    if (input.toLowerCase() !== 'closed') {
      const [open, close] = input.split('-');
      if (open && close) hours[d] = [[open.trim(), close.trim()]];
    }
  }

  // Services
  console.log('\nServices — press Enter with no name when done:');
  const services: Array<{ service: string; price_zar: number; duration_min: number }> = [];
  while (true) {
    const svcName = await ask('  Service name (or Enter to finish)', '');
    if (!svcName) break;
    const price = await askNum('  Price (ZAR)', 0);
    const duration = await askNum('  Duration (minutes)', 30);
    services.push({ service: svcName, price_zar: price, duration_min: duration });
    console.log(`  ✓ Added: ${svcName} — R${price} (${duration} min)\n`);
  }

  // FAQs
  console.log('\nFAQs — press Enter with no question when done (optional):');
  const faqs: Array<{ q: string; a: string }> = [];
  while (true) {
    const q = await ask('  Question (or Enter to skip)', '');
    if (!q) break;
    const a = await ask('  Answer');
    faqs.push({ q, a });
    console.log('  ✓ Added\n');
  }

  rl.close();

  console.log('\nCreating clinic in Supabase...');
  const { data, error } = await supabase
    .from('clinics')
    .insert({
      name,
      twilio_number: twilioNumber || null,
      timezone,
      hours_json: hours,
      services_json: services,
      faq_json: faqs,
      tone_notes: toneNotes || null,
      escalation_contact: escalationContact || null,
      avg_new_client_value_zar: avgValue,
    })
    .select()
    .single();

  if (error) {
    console.error('✗ Supabase error:', error.message);
    process.exit(1);
  }

  console.log(`\n✓ Clinic created!`);
  console.log(`  ID:   ${data.id}`);
  console.log(`  Name: ${data.name}`);
  if (data.twilio_number) console.log(`  Tel:  ${data.twilio_number}`);

  // Offer to write DEFAULT_CLINIC_ID
  const makeDefault = await new Promise<string>((res) => {
    const r2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    r2.question('\nSet as default clinic in .env? [Y/n]: ', (ans) => { r2.close(); res(ans.trim()); });
  });

  if (!makeDefault || makeDefault.toLowerCase() !== 'n') {
    const envPath = `${process.cwd()}/.env`;
    let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (/^DEFAULT_CLINIC_ID=/m.test(env)) {
      env = env.replace(/^DEFAULT_CLINIC_ID=.*/m, `DEFAULT_CLINIC_ID=${data.id}`);
    } else {
      env += `\nDEFAULT_CLINIC_ID=${data.id}\n`;
    }
    fs.writeFileSync(envPath, env);
    console.log('✓ DEFAULT_CLINIC_ID written to .env');
  }

  console.log('\nDone! Start Remi with: npm run dev\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
