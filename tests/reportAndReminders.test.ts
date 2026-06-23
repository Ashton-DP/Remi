// Report math + reminder scheduling tests. Run: tsx tests/reportAndReminders.test.ts
import assert from 'node:assert';
import { computeReportStats, buildHuddle } from '../src/report';
import { buildReminderRows } from '../src/lib/reminders';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exit(1);
  }
}

(async () => {
  console.log('report stats math');

  await test('sums revenue and counts across event types', () => {
    const events = [
      { type: 'booking_created', value_zar: 800 },
      { type: 'booking_created', value_zar: 1200 },
      { type: 'slot_backfilled', value_zar: 500 },
      { type: 'missed_call_recovered', value_zar: 300 },
      { type: 'escalation_created' },
    ];
    const bookings = [
      { status: 'confirmed' },
      { status: 'confirmed' },
      { status: 'confirmed' },
      { status: 'cancelled' },
    ];
    const s = computeReportStats(events, bookings);
    assert.equal(s.bookedN, 3); // 2 created + 1 backfill
    assert.equal(s.bookedR, 2500); // 800+1200+500
    assert.equal(s.recoveredR, 800); // 300 recovered + 500 backfill
    assert.equal(s.backfillN, 1);
    assert.equal(s.escalations, 1);
    assert.equal(s.confirmed, 3);
    assert.equal(s.cancelled, 1);
    assert.equal(s.noShowRate, 25); // 1 / 4
  });

  await test('handles empty input without dividing by zero', () => {
    const s = computeReportStats([], []);
    assert.equal(s.bookedN, 0);
    assert.equal(s.bookedR, 0);
    assert.equal(s.noShowRate, 0);
  });

  await test('treats missing value_zar as 0', () => {
    const s = computeReportStats([{ type: 'booking_created' }], []);
    assert.equal(s.bookedN, 1);
    assert.equal(s.bookedR, 0);
  });

  await test('rounds cancellation rate', () => {
    const s = computeReportStats([], [
      { status: 'confirmed' }, { status: 'confirmed' }, { status: 'cancelled' },
    ]);
    assert.equal(s.noShowRate, 33); // 1/3 → 33
  });

  console.log('reminder scheduling');

  const NOW = Date.parse('2026-06-21T08:00:00Z');

  await test('far-future booking gets all 3 reminders + aftercare + review', () => {
    const start = '2026-06-25T09:00:00Z'; // 4 days out
    const rows = buildReminderRows('bk1', start, NOW);
    const kinds = rows.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['24h', '2h', '48h', 'aftercare', 'review'].sort());
  });

  await test('reminder times are start minus the offset', () => {
    const start = '2026-06-25T09:00:00Z';
    const rows = buildReminderRows('bk1', start, NOW);
    const startMs = Date.parse(start);
    const r48 = rows.find((r) => r.kind === '48h')!;
    const r2 = rows.find((r) => r.kind === '2h')!;
    assert.equal(Date.parse(r48.scheduled_for), startMs - 48 * 3_600_000);
    assert.equal(Date.parse(r2.scheduled_for), startMs - 2 * 3_600_000);
  });

  await test('past pre-reminders are dropped, aftercare/review always added', () => {
    // Booking starts in 1 hour → 48h/24h/2h are all in the past, dropped.
    const start = '2026-06-21T09:00:00Z'; // NOW + 1h
    const rows = buildReminderRows('bk1', start, NOW);
    const kinds = rows.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['aftercare', 'review']);
  });

  await test('aftercare is +3h and review is +24h after the appointment', () => {
    const start = '2026-06-25T09:00:00Z';
    const startMs = Date.parse(start);
    const rows = buildReminderRows('bk1', start, NOW);
    assert.equal(Date.parse(rows.find((r) => r.kind === 'aftercare')!.scheduled_for), startMs + 3 * 3_600_000);
    assert.equal(Date.parse(rows.find((r) => r.kind === 'review')!.scheduled_for), startMs + 24 * 3_600_000);
  });

  console.log('morning huddle');

  const huddleBookings = [
    { start_at: '2026-06-25T07:00:00Z', service: 'Botox', clients: { name: 'Sarah', intake_submitted_at: null } },
    { start_at: '2026-06-25T08:30:00Z', service: 'Filler', clients: { name: 'Thabo', intake_submitted_at: '2026-06-20' } },
  ];

  await test('huddle lists count + clinic-local times in order', () => {
    const h = buildHuddle(huddleBookings, 'Demo', 'Africa/Johannesburg', false);
    assert.ok(h.includes('2 appointments at Demo'));
    assert.ok(h.includes('09:00 · Botox · Sarah'), h);   // 07:00Z → 09:00 SAST
    assert.ok(h.includes('10:30 · Filler · Thabo'), h);
  });

  await test('huddle flags intake-pending only when intake enabled', () => {
    assert.ok(buildHuddle(huddleBookings, 'Demo', 'Africa/Johannesburg', true).includes('Sarah ⚠️ intake pending'));
    assert.ok(!buildHuddle(huddleBookings, 'Demo', 'Africa/Johannesburg', false).includes('intake pending'));
  });

  await test('huddle handles an empty day', () => {
    assert.ok(buildHuddle([], 'Demo').includes('No appointments'));
  });

  console.log(`\n${passed} report+reminder tests passed ✅`);
})();
