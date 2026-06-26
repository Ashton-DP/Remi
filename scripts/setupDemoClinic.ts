/**
 * Sets up the Aesthetics demo clinic with realistic data for the Remi ad shoot.
 * Usage: tsx scripts/setupDemoClinic.ts <clinicId>
 *
 * Populates:
 *  - Clinic knowledge, services, hours
 *  - 6 appointments for today (Mrs Dlamini 9am cancelled, gap at 11am)
 *  - Thabo Nkosi on waitlist
 *  - 3 overdue invoices (Sarah Botha R1800 paid, 2 others overdue)
 */
import { supabase } from '../src/lib/supabase';

const clinicId = process.argv[2];
if (!clinicId) { console.error('Usage: tsx scripts/setupDemoClinic.ts <clinicId>'); process.exit(1); }

const tz = 'Africa/Johannesburg';

function todayAt(hour: number, minute = 0): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function tomorrowAt(hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

async function upsertClient(name: string, phone: string) {
  const { data: existing } = await supabase
    .from('clients').select('id').eq('clinic_id', clinicId).eq('phone', phone).maybeSingle();
  if (existing) {
    await supabase.from('clients').update({ name }).eq('id', existing.id);
    return existing.id as string;
  }
  const { data, error } = await supabase
    .from('clients').insert({ clinic_id: clinicId, name, phone }).select('id').single();
  if (error) throw new Error(`Client ${name}: ${error.message}`);
  return data.id as string;
}

async function createBooking(clientId: string, service: string, startIso: string, endIso: string, status = 'confirmed') {
  const { error } = await supabase.from('bookings').insert({
    clinic_id: clinicId, client_id: clientId,
    service, start_at: startIso, end_at: endIso,
    status, source: 'demo',
  });
  if (error && !error.message.includes('duplicate')) throw new Error(`Booking ${service}: ${error.message}`);
}

async function createInvoice(clientId: string, amount: number, status: 'overdue' | 'paid', chaseStage = 1) {
  const num = `INV-DEMO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const due = new Date();
  due.setDate(due.getDate() - 14); // 2 weeks overdue
  const { error } = await supabase.from('invoices').insert({
    clinic_id: clinicId, client_id: clientId,
    invoice_number: num, amount_due: amount,
    due_date: due.toISOString().slice(0, 10),
    status, chase_stage: chaseStage, source: 'demo',
  });
  if (error) throw new Error(`Invoice ${num}: ${error.message}`);
}

(async () => {
  console.log(`Setting up demo clinic ${clinicId}…`);

  // ── 1. Clinic settings ───────────────────────────────────────────────────
  const { error: clinicErr } = await supabase.from('clinics').update({
    name: 'Aesthetics by Remi',
    timezone: tz,
    knowledge: `Located at 14 Sandton Drive, Sandton, Johannesburg. Free parking in the building basement.
We accept cash, card, EFT and medical aid (Discovery, Momentum, Bonitas).
Clients must arrive 5 minutes early. All treatments by qualified aesthetic practitioners.
Patch tests required 48 hours before first-time filler. No refunds — results may vary per individual.
Owner: Ashton. Escalation contact: +27665355882.`,
    tone_notes: 'Warm, confident, premium feel. Clients are mostly professionals aged 28-55.',
    services_json: [
      { service: 'Botox', price_zar: 2800, duration_min: 30, prep: 'Avoid blood thinners 48hrs before. No alcohol 24hrs before.' },
      { service: 'Lip Filler', price_zar: 3200, duration_min: 45, prep: 'Patch test required 48hrs prior.' },
      { service: 'Cheek Filler', price_zar: 3800, duration_min: 45, prep: 'Patch test required 48hrs prior.' },
      { service: 'Hydrafacial', price_zar: 1200, duration_min: 60, prep: 'Arrive with clean skin, no makeup.' },
      { service: 'Chemical Peel', price_zar: 950, duration_min: 45, prep: 'Avoid retinol 5 days before.' },
      { service: 'Consultation', price_zar: 0, duration_min: 30, prep: '' },
    ],
    hours_json: {
      mon: [['08:00', '17:00']],
      tue: [['08:00', '17:00']],
      wed: [['08:00', '17:00']],
      thu: [['08:00', '17:00']],
      fri: [['08:00', '15:00']],
      sat: [['09:00', '13:00']],
      sun: [],
    },
    faq_json: [
      { q: 'Do you offer payment plans?', a: 'We accept medical aid and card. Payment plans are not available at this time.' },
      { q: 'How long do results last?', a: 'Botox typically lasts 3-4 months. Fillers 9-18 months depending on the area and product used.' },
      { q: 'Is it painful?', a: 'We use topical numbing cream for most treatments. Most clients describe it as very tolerable.' },
      { q: 'Do I need a consultation first?', a: 'For first-time filler clients, yes — it\'s a free 30-minute session with our practitioner.' },
    ],
  }).eq('id', clinicId);
  if (clinicErr) throw new Error(`Clinic update: ${clinicErr.message}`);
  console.log('✓ Clinic settings updated');

  // ── 2. Clients ───────────────────────────────────────────────────────────
  const [dlaminiId, thaboId, sarahId, priyaId, kevinId, zaneleId] = await Promise.all([
    upsertClient('Mrs Dlamini', '+27821000001'),
    upsertClient('Thabo Nkosi', '+27821000002'),
    upsertClient('Sarah Botha', '+27821000003'),
    upsertClient('Priya Naidoo', '+27821000004'),
    upsertClient('Kevin van der Berg', '+27821000005'),
    upsertClient('Zanele Mokoena', '+27821000006'),
  ]);
  console.log('✓ Clients created');

  // ── 3. Today's bookings ──────────────────────────────────────────────────
  // 9am  — Mrs Dlamini (Botox) — CANCELLED → moved to tomorrow
  // 10am — Priya Naidoo (Lip Filler)
  // 11am — GAP (no booking = available slot for waitlist)
  // 12pm — Kevin van der Berg (Hydrafacial)
  // 14pm — Zanele Mokoena (Chemical Peel)
  // 15pm — Sarah Botha (Consultation)
  await createBooking(dlaminiId, 'Botox', todayAt(9), todayAt(9, 30), 'cancelled');
  await createBooking(priyaId, 'Lip Filler', todayAt(10), todayAt(10, 45));
  await createBooking(kevinId, 'Hydrafacial', todayAt(12), todayAt(13));
  await createBooking(zaneleId, 'Chemical Peel', todayAt(14), todayAt(14, 45));
  await createBooking(sarahId, 'Consultation', todayAt(15), todayAt(15, 30));
  // Mrs Dlamini rescheduled to tomorrow
  await createBooking(dlaminiId, 'Botox', tomorrowAt(9), tomorrowAt(9, 30));
  console.log('✓ Today\'s appointments created (gap at 11am, Mrs Dlamini cancelled + moved to tomorrow)');

  // ── 4. Waitlist ──────────────────────────────────────────────────────────
  // Clear existing waitlist entries for Thabo first
  await supabase.from('waitlist').delete().eq('clinic_id', clinicId).eq('client_id', thaboId);
  const { error: wlErr } = await supabase.from('waitlist').insert({
    clinic_id: clinicId, client_id: thaboId,
    service: 'Botox', preferred_window: 'any time', status: 'waiting', position: 1,
  });
  if (wlErr) throw new Error(`Waitlist: ${wlErr.message}`);
  console.log('✓ Thabo Nkosi added to waitlist for Botox');

  // ── 5. Invoices ──────────────────────────────────────────────────────────
  // Sarah Botha R1800 — PAID
  await createInvoice(sarahId, 1800, 'paid', 0);
  // Two others overdue
  await createInvoice(priyaId, 1400, 'overdue', 2);
  await createInvoice(kevinId, 1000, 'overdue', 1);
  console.log('✓ Invoices created (Sarah Botha R1800 paid, Priya R1400 + Kevin R1000 overdue = R2400 outstanding)');

  console.log(`
✅ Demo clinic fully set up!

Call your Remi number and say:
  "Hey Remi, how's my day looking?"
  → Remi will report 5 appointments, Mrs Dlamini cancelled, gap at 11am, 1 on waitlist, 2 overdue invoices

  "Put the next person on the waitlist in the 11am slot."
  → Remi books Thabo Nkosi at 11am

  "Any outstanding invoices?"
  → Remi reports 2 overdue totalling R2,400 — and mentions Sarah Botha paid R1,800

  Speak Afrikaans — Remi replies in Afrikaans.
`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
