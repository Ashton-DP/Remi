// Remi Growth guardrail logic. Run: tsx tests/growth.test.ts
import assert from 'node:assert';
import {
  DEFAULT_GROWTH_SETTINGS, mergeGrowthSettings, clampPct, allowedDiscount, isAuto, isEnabled,
} from '../src/lib/growth';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('growth guardrails');

test('clampPct bounds 0..100 and rounds', () => {
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(150), 100);
  assert.equal(clampPct(12.6), 13);
  assert.equal(clampPct('abc'), 0);
});

test('allowedDiscount never exceeds the owner cap (the core guardrail)', () => {
  const s = mergeGrowthSettings({ max_discount_pct: 15 });
  assert.equal(allowedDiscount(50, s), 15);  // Remi asked 50, owner caps at 15
  assert.equal(allowedDiscount(10, s), 10);  // under cap → honoured
  assert.equal(allowedDiscount(999, s), 15);
});

test('allowedDiscount is 0 when discounts are not allowed (default)', () => {
  const s = mergeGrowthSettings(null); // default max_discount_pct = 0
  assert.equal(allowedDiscount(20, s), 0);
});

test('defaults are conservative: no discount, cold-outreach types off', () => {
  assert.equal(DEFAULT_GROWTH_SETTINGS.max_discount_pct, 0);
  assert.equal(DEFAULT_GROWTH_SETTINGS.referral.enabled, false);
  assert.equal(DEFAULT_GROWTH_SETTINGS.offpeak.enabled, false);
  assert.equal(DEFAULT_GROWTH_SETTINGS.gap_fill.approval, 'ask'); // never auto by default
});

test('mergeGrowthSettings overlays stored over defaults + clamps the cap', () => {
  const s = mergeGrowthSettings({ max_discount_pct: 200, referral: { enabled: true, reward: 'R50 off both' } });
  assert.equal(s.max_discount_pct, 100);            // clamped
  assert.equal(s.referral.enabled, true);
  assert.equal(s.referral.reward, 'R50 off both');
  assert.equal(s.gap_fill.enabled, true);           // default preserved
});

test('isAuto / isEnabled read per-type config', () => {
  const s = mergeGrowthSettings({ gap_fill: { enabled: true, approval: 'auto' }, winback: { enabled: false } as any });
  assert.equal(isAuto('gap_fill', s), true);
  assert.equal(isAuto('winback', s), false);
  assert.equal(isEnabled('winback', s), false);
  assert.equal(isEnabled('gap_fill', s), true);
});

console.log(`\n${passed} passed\n`);
