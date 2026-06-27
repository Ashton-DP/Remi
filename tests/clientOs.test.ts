// Client OS pure-logic tests. Run: tsx tests/clientOs.test.ts
import assert from 'node:assert';
import { sessionsRemaining, isPackageActive, isLowPackage, mapStripeSubStatus } from '../src/lib/clientOs';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('client os');

const NOW = Date.parse('2026-06-27T12:00:00Z');
const future = '2026-12-01T00:00:00Z';
const past = '2026-01-01T00:00:00Z';

test('sessionsRemaining subtracts used from total', () => {
  assert.equal(sessionsRemaining({ sessions_total: 10, sessions_used: 3 }), 7);
});
test('sessionsRemaining never goes negative', () => {
  assert.equal(sessionsRemaining({ sessions_total: 5, sessions_used: 8 }), 0);
});

test('isPackageActive true when sessions left and no expiry', () => {
  assert.equal(isPackageActive({ sessions_total: 10, sessions_used: 9 }, NOW), true);
});
test('isPackageActive false when fully used', () => {
  assert.equal(isPackageActive({ sessions_total: 10, sessions_used: 10 }, NOW), false);
});
test('isPackageActive false when expired even with sessions left', () => {
  assert.equal(isPackageActive({ sessions_total: 10, sessions_used: 1, expires_at: past }, NOW), false);
});
test('isPackageActive true when not yet expired', () => {
  assert.equal(isPackageActive({ sessions_total: 10, sessions_used: 1, expires_at: future }, NOW), true);
});

test('isLowPackage true at/under threshold', () => {
  assert.equal(isLowPackage({ sessions_total: 10, sessions_used: 8 }, 2, NOW), true); // 2 left
  assert.equal(isLowPackage({ sessions_total: 10, sessions_used: 9 }, 2, NOW), true); // 1 left
});
test('isLowPackage false above threshold', () => {
  assert.equal(isLowPackage({ sessions_total: 10, sessions_used: 5 }, 2, NOW), false); // 5 left
});
test('isLowPackage false when none left (handled by full-use nudge, not low)', () => {
  assert.equal(isLowPackage({ sessions_total: 10, sessions_used: 10 }, 2, NOW), false);
});
test('isLowPackage false when expired', () => {
  assert.equal(isLowPackage({ sessions_total: 10, sessions_used: 9, expires_at: past }, 2, NOW), false);
});

test('mapStripeSubStatus maps active/trialing → active', () => {
  assert.equal(mapStripeSubStatus('active'), 'active');
  assert.equal(mapStripeSubStatus('trialing'), 'active');
});
test('mapStripeSubStatus maps past_due/unpaid/incomplete → past_due', () => {
  assert.equal(mapStripeSubStatus('past_due'), 'past_due');
  assert.equal(mapStripeSubStatus('unpaid'), 'past_due');
  assert.equal(mapStripeSubStatus('incomplete'), 'past_due');
});
test('mapStripeSubStatus maps paused → paused', () => {
  assert.equal(mapStripeSubStatus('paused'), 'paused');
});
test('mapStripeSubStatus maps canceled/unknown → cancelled', () => {
  assert.equal(mapStripeSubStatus('canceled'), 'cancelled');
  assert.equal(mapStripeSubStatus('incomplete_expired'), 'cancelled');
  assert.equal(mapStripeSubStatus('whatever'), 'cancelled');
});

console.log(`\n${passed} passed\n`);
