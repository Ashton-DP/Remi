// Remi Growth guardrail logic. Run: tsx tests/growth.test.ts
import assert from 'node:assert';
import {
  DEFAULT_GROWTH_SETTINGS, mergeGrowthSettings, clampPct, allowedDiscount, isAuto, isEnabled, cadenceOverdue,
} from '../src/lib/growth';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-28T12:00:00Z');

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

test('cadenceOverdue: null with fewer than 2 visits', () => {
  assert.equal(cadenceOverdue([], 14, NOW), null);
  assert.equal(cadenceOverdue([NOW - 30 * DAY], 14, NOW), null);
});

test('cadenceOverdue: overdue when gap exceeds avg interval + buffer', () => {
  // ~30-day cadence, last visit 60 days ago → overdue
  const visits = [NOW - 120 * DAY, NOW - 90 * DAY, NOW - 60 * DAY];
  const v = cadenceOverdue(visits, 14, NOW)!;
  assert.equal(v.cadenceDays, 30);
  assert.equal(v.overdue, true);
});

test('cadenceOverdue: NOT overdue when within their normal rhythm', () => {
  // ~30-day cadence, last visit 20 days ago → not yet due
  const visits = [NOW - 80 * DAY, NOW - 50 * DAY, NOW - 20 * DAY];
  const v = cadenceOverdue(visits, 14, NOW)!;
  assert.equal(v.overdue, false);
});

test('cadenceOverdue: buffer prevents nagging just past the average', () => {
  // 30-day cadence, last visit 35 days ago: past avg but within the 14-day buffer
  const visits = [NOW - 65 * DAY, NOW - 35 * DAY];
  assert.equal(cadenceOverdue(visits, 14, NOW)!.overdue, false);
  // same client with no buffer → would be overdue
  assert.equal(cadenceOverdue(visits, 0, NOW)!.overdue, true);
});

test('cadenceOverdue: not overdue if a visit is upcoming', () => {
  const visits = [NOW - 30 * DAY, NOW + 3 * DAY];
  assert.equal(cadenceOverdue(visits, 14, NOW)!.overdue, false);
});

console.log(`\n${passed} passed\n`);
