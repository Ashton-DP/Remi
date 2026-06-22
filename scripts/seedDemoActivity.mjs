// Populate the demo/sandbox clinic with realistic activity so the dashboard
// shows what a live, busy clinic looks like: bookings, recovered revenue, missed
// calls, conversations, an open escalation. Idempotent-ish: clears prior demo
// activity for the clinic first, then re-inserts a fresh set.
// Run: node --env-file=.env scripts/seedDemoActivity.mjs [clinic_id]
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const s = createClient(url, key);

const DEMO_NAME = 'Remi Demo Clinic (Sandbox)';
const argId = process.argv[2];

const hrsAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

async function getClinicId() {
  if (argId) return argId;
  const { data } = await s.from('clinics').select('id').eq('name', DEMO_NAME).maybeSingle();
  if (!data) throw new Error(`Demo clinic not found. Run seedDemoClinic.mjs first, or pass a clinic_id.`);
  return data.id;
}

async function main() {
  const clinicId = await getClinicId();
  console.log('Seeding activity for clinic', clinicId);

  // --- wipe prior demo activity for a clean slate ---
  const { data: oldClients } = await s.from('clients').select('id').eq('clinic_id', clinicId);
  const oldClientIds = (oldClients ?? []).map((c) => c.id);
  const { data: oldConvos } = await s.from('conversations').select('id').eq('clinic_id', clinicId);
  const oldConvoIds = (oldConvos ?? []).map((c) => c.id);
  if (oldConvoIds.length) {
    await s.from('messages').delete().in('conversation_id', oldConvoIds);
    await s.from('escalations').delete().in('conversation_id', oldConvoIds);
  }
  await s.from('events').delete().eq('clinic_id', clinicId);
  // reminders FK → bookings, so clear them before bookings or the delete fails
  const { data: oldBookings } = await s.from('bookings').select('id').eq('clinic_id', clinicId);
  const oldBookingIds = (oldBookings ?? []).map((b) => b.id);
  if (oldBookingIds.length) await s.from('reminders').delete().in('booking_id', oldBookingIds);
  await s.from('bookings').delete().eq('clinic_id', clinicId);
  await s.from('conversations').delete().eq('clinic_id', clinicId);
  if (oldClientIds.length) await s.from('clients').delete().in('id', oldClientIds);

  // --- clients ---
  const clientRows = [
    { clinic_id: clinicId, name: 'Sarah Naidoo', phone: 'whatsapp:+27821110001', consent_at: hrsAgo(50) },
    { clinic_id: clinicId, name: 'Thabo Mokoena', phone: 'whatsapp:+27821110002', consent_at: hrsAgo(30) },
    { clinic_id: clinicId, name: 'Aisha Patel', phone: 'whatsapp:+27821110003', consent_at: hrsAgo(8) },
    { clinic_id: clinicId, name: 'Lerato Dlamini', phone: 'whatsapp:+27821110004', consent_at: hrsAgo(3) },
  ];
  const { data: clients, error: ce } = await s.from('clients').insert(clientRows).select('id,name');
  if (ce) throw new Error('clients: ' + ce.message);
  const byName = Object.fromEntries(clients.map((c) => [c.name, c.id]));

  // --- bookings ---
  const bookingRows = [
    { clinic_id: clinicId, client_id: byName['Sarah Naidoo'], service: 'Botox treatment', start_at: daysFromNow(2), end_at: daysFromNow(2), status: 'confirmed', source: 'whatsapp', after_hours: true, calendar_event_id: 'demo' },
    { clinic_id: clinicId, client_id: byName['Thabo Mokoena'], service: 'Dermal filler', start_at: daysFromNow(4), end_at: daysFromNow(4), status: 'confirmed', source: 'missed_call', after_hours: true, calendar_event_id: 'demo' },
    { clinic_id: clinicId, client_id: byName['Aisha Patel'], service: 'Skin rejuvenation facial', start_at: daysFromNow(1), end_at: daysFromNow(1), status: 'confirmed', source: 'whatsapp', calendar_event_id: 'demo' },
    { clinic_id: clinicId, client_id: byName['Lerato Dlamini'], service: 'Botox consultation', start_at: daysFromNow(-1), end_at: daysFromNow(-1), status: 'cancelled', source: 'whatsapp', calendar_event_id: 'demo' },
  ];
  const { data: bookings, error: be } = await s.from('bookings').insert(bookingRows).select('id,service');
  if (be) throw new Error('bookings: ' + be.message);
  const bookingId = (svc) => bookings.find((b) => b.service === svc)?.id;

  // --- events (drive the dashboard cards / "R recovered") ---
  const eventRows = [
    { clinic_id: clinicId, type: 'booking_created', value_zar: 2500, booking_id: bookingId('Botox treatment') },
    { clinic_id: clinicId, type: 'booking_created', value_zar: 3500, booking_id: bookingId('Dermal filler') },
    { clinic_id: clinicId, type: 'booking_created', value_zar: 1200, booking_id: bookingId('Skin rejuvenation facial') },
    { clinic_id: clinicId, type: 'missed_call_recovered', value_zar: 3500, booking_id: bookingId('Dermal filler') },
    { clinic_id: clinicId, type: 'slot_backfilled', value_zar: 1200 },
    { clinic_id: clinicId, type: 'missed_call', value_zar: 0 },
    { clinic_id: clinicId, type: 'missed_call', value_zar: 0 },
    { clinic_id: clinicId, type: 'escalation_created', value_zar: 0 },
  ];
  const { error: ee } = await s.from('events').insert(eventRows);
  if (ee) throw new Error('events: ' + ee.message);

  // --- conversations + messages ---
  const convoRows = [
    { clinic_id: clinicId, client_id: byName['Sarah Naidoo'], channel: 'whatsapp', status: 'booked', last_message_at: hrsAgo(50) },
    { clinic_id: clinicId, client_id: byName['Thabo Mokoena'], channel: 'missed_call', status: 'booked', last_message_at: hrsAgo(30) },
    { clinic_id: clinicId, client_id: byName['Aisha Patel'], channel: 'whatsapp', status: 'open', last_message_at: hrsAgo(6) },
    { clinic_id: clinicId, client_id: byName['Lerato Dlamini'], channel: 'whatsapp', status: 'escalated', last_message_at: hrsAgo(2) },
  ];
  const { data: convos, error: cve } = await s.from('conversations').insert(convoRows).select('id,client_id');
  if (cve) throw new Error('conversations: ' + cve.message);
  const convoByClient = Object.fromEntries(convos.map((c) => [c.client_id, c.id]));

  await s.from('messages').insert([
    { conversation_id: convoByClient[byName['Sarah Naidoo']], direction: 'in', body: 'Hi, do you have Botox availability this week?' },
    { conversation_id: convoByClient[byName['Sarah Naidoo']], direction: 'out', body: 'Yes! I have Thursday 09:00 or 14:00 — which suits?' },
    { conversation_id: convoByClient[byName['Aisha Patel']], direction: 'in', body: 'How much is a rejuvenation facial?' },
    { conversation_id: convoByClient[byName['Lerato Dlamini']], direction: 'in', body: 'I need to speak to someone about a reaction I had.' },
  ]);

  // --- open escalation (Lerato) ---
  await s.from('escalations').insert([
    { conversation_id: convoByClient[byName['Lerato Dlamini']], reason: 'clinical_question', summary: 'Patient reports a reaction — needs a human to call back.', status: 'open' },
  ]);

  console.log('\n✅ Demo activity seeded:');
  console.log('   4 clients · 3 confirmed + 1 cancelled booking · R7,200 booked · R4,700 recovered · 2 missed calls · 1 open escalation');
  console.log(`   View: https://www.remireception.com/dashboard/${clinicId}?token=<DASHBOARD_TOKEN>`);
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
