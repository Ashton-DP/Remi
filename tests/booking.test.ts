// Booking-layer tests. Run: node_modules/.bin/tsx tests/booking.test.ts
// No framework — tiny assert harness; exits non-zero on first failure.
import assert from 'node:assert';
import { getBookingProvider, registerBookingProvider } from '../src/lib/booking';
import type { BookingProvider } from '../src/lib/booking';
import { googleProvider } from '../src/lib/booking/googleProvider';
import { computeFreeSlots } from '../src/lib/slots';

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
  console.log('booking provider registry');

  await test('defaults to Google when no provider set', () => {
    assert.equal(getBookingProvider({}).name, 'google');
    assert.equal(getBookingProvider({ booking_provider: 'google' }).name, 'google');
  });

  await test('falls back to Google for a not-yet-built provider', () => {
    assert.equal(getBookingProvider({ booking_provider: 'fresha' }).name, 'google');
    assert.equal(getBookingProvider({ booking_provider: 'acuity' }).name, 'google');
  });

  await test('falls back to Google for an unknown provider', () => {
    assert.equal(getBookingProvider({ booking_provider: 'totally-made-up' }).name, 'google');
  });

  await test('provider name match is case-insensitive', () => {
    assert.equal(getBookingProvider({ booking_provider: 'GOOGLE' }).name, 'google');
  });

  console.log('google provider — demo mode (no credentials)');

  await test('createEvent returns a demo id when unconfigured', async () => {
    const ev = await googleProvider.createEvent({}, {
      summary: 'x', startISO: '2099-01-01T09:00:00+02:00', endISO: '2099-01-01T09:30:00+02:00',
    });
    assert.equal(ev.id, 'demo-no-calendar');
  });

  await test('getBusy returns empty (open diary) when unconfigured', async () => {
    const busy = await googleProvider.getBusy({}, '2099-01-01T00:00:00Z', '2099-01-01T23:59:59Z');
    assert.deepEqual(busy, []);
  });

  await test('update/cancel are safe no-ops on demo ids', async () => {
    await googleProvider.updateEvent({}, 'demo-no-calendar', {
      summary: 'x', startISO: '2099-01-01T10:00:00+02:00', endISO: '2099-01-01T10:30:00+02:00',
    });
    await googleProvider.cancelEvent({}, 'demo-no-calendar');
  });

  console.log('registerBookingProvider + slot finding through the abstraction');

  // A fake provider with a controllable busy diary, used to prove slot finding
  // and overlap-skipping work through getBookingProvider (not Google-specific).
  const busyWindows: { start: string; end: string }[] = [];
  const fake: BookingProvider = {
    name: 'fake',
    async getBusy() { return busyWindows; },
    async createEvent() { return { id: 'fake-1' }; },
    async updateEvent() {},
    async cancelEvent() {},
  };
  registerBookingProvider(fake);

  await test('registered provider is resolvable', () => {
    assert.equal(getBookingProvider({ booking_provider: 'fake' }).name, 'fake');
  });

  const clinic = {
    booking_provider: 'fake',
    timezone: 'Africa/Johannesburg',
    hours_json: { mon: [['09:00', '12:00']] }, // 3h window
    services_json: [{ service: 'Consultation', duration_min: 30 }],
  };
  // A Monday far in the future so no slot is "in the past".
  const MON = '2099-01-05'; // 2099-01-05 is a Monday

  await test('open diary yields back-to-back 30-min slots within hours', async () => {
    busyWindows.length = 0;
    const slots = await computeFreeSlots(clinic, MON, 'Consultation');
    // 09:00,09:30,10:00,10:30,11:00,11:30 → capped at 5 by computeFreeSlots
    assert.equal(slots.length, 5);
    assert.ok(slots[0].startsWith(`${MON}T09:00:00`), `first slot was ${slots[0]}`);
    assert.ok(slots[0].includes('+02:00'), 'slot carries clinic tz offset');
  });

  await test('a busy window removes the overlapping slot', async () => {
    busyWindows.length = 0;
    busyWindows.push({ start: `${MON}T09:00:00+02:00`, end: `${MON}T09:30:00+02:00` });
    const slots = await computeFreeSlots(clinic, MON, 'Consultation');
    assert.ok(!slots.some((s) => s.startsWith(`${MON}T09:00:00`)), '09:00 should be busy');
    assert.ok(slots.some((s) => s.startsWith(`${MON}T09:30:00`)), '09:30 should be free');
  });

  console.log(`\n${passed} booking tests passed ✅`);
})();
