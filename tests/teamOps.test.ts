// Team Ops pure-logic tests. Run: tsx tests/teamOps.test.ts
import assert from 'node:assert';
import { sumHours, formatHours, leaveDays, startOfWeek } from '../src/lib/teamOps';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('team ops');

const T0 = Date.parse('2026-06-22T08:00:00Z'); // a Monday

test('sumHours adds completed shifts', () => {
  assert.equal(sumHours([
    { clock_in: '2026-06-22T08:00:00Z', clock_out: '2026-06-22T12:00:00Z' }, // 4h
    { clock_in: '2026-06-22T13:00:00Z', clock_out: '2026-06-22T17:30:00Z' }, // 4.5h
  ]), 8.5);
});
test('sumHours counts an open shift up to now', () => {
  const now = Date.parse('2026-06-22T10:00:00Z');
  assert.equal(sumHours([{ clock_in: '2026-06-22T08:00:00Z', clock_out: null }], now), 2);
});
test('sumHours ignores garbage / negative spans', () => {
  assert.equal(sumHours([{ clock_in: 'nope', clock_out: 'also nope' }]), 0);
  assert.equal(sumHours([{ clock_in: '2026-06-22T12:00:00Z', clock_out: '2026-06-22T08:00:00Z' }]), 0);
});
test('formatHours renders h/m', () => {
  assert.equal(formatHours(8.5), '8h 30m');
  assert.equal(formatHours(3), '3h');
  assert.equal(formatHours(0.25), '15m');
});
test('leaveDays is inclusive', () => {
  assert.equal(leaveDays('2026-06-22', '2026-06-26'), 5); // Mon–Fri
  assert.equal(leaveDays('2026-06-22', '2026-06-22'), 1); // single day
  assert.equal(leaveDays('2026-06-26', '2026-06-22'), 0); // backwards → invalid
});
test('startOfWeek lands on Monday 00:00 UTC', () => {
  const s = new Date(startOfWeek(T0));
  assert.equal(s.getUTCDay(), 1); // Monday
  assert.equal(s.getUTCHours(), 0);
});

console.log(`\n${passed} passed`);
