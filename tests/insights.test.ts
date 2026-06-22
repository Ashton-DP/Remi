// Dashboard insights tests. Run: tsx tests/insights.test.ts
import assert from 'node:assert';
import { computeInsights } from '../src/dashboard';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

const bookings = [
  { service: 'Botox', after_hours: true, start_at: '2026-06-25T09:00:00+02:00' },   // Thu
  { service: 'Botox', after_hours: false, start_at: '2026-06-26T09:00:00+02:00' },  // Fri
  { service: 'Filler', after_hours: true, start_at: '2026-06-25T10:00:00+02:00' },  // Thu
];

console.log('dashboard insights');

test('conversion rate = bookings / conversations, capped at 100', () => {
  assert.equal(computeInsights(bookings, 6, 3).conversionRate, 50);
  assert.equal(computeInsights(bookings, 2, 5).conversionRate, 100); // capped
  assert.equal(computeInsights(bookings, 0, 0).conversionRate, 0);   // no div-by-zero
});

test('after-hours % from the after_hours flag', () => {
  assert.equal(computeInsights(bookings, 6, 3).afterHoursPct, 67); // 2/3
});

test('top service = most frequent', () => {
  assert.equal(computeInsights(bookings, 6, 3).topService, 'Botox');
});

test('busiest day = weekday with most appointments', () => {
  assert.equal(computeInsights(bookings, 6, 3).busiestDay, 'Thu');
});

test('empty bookings degrade gracefully', () => {
  const i = computeInsights([], 0, 0);
  assert.equal(i.afterHoursPct, 0);
  assert.equal(i.topService, '—');
  assert.equal(i.busiestDay, '—');
});

console.log(`\n${passed} insights tests passed ✅`);
