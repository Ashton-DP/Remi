// Recurring-billing provider pure-logic tests. Run: tsx tests/subscriptions.test.ts
import assert from 'node:assert';
import {
  payfastFrequency, buildPayfastSubscriptionParams, buildPayfastApiSignature,
  mapPayfastStatus, isMembershipPaymentId, membershipIdFromPaymentId, payfastTimestamp,
} from '../src/lib/payments/payfastSubscriptions';
import { buildPayfastSignature } from '../src/lib/payments/payfast';
import { paystackInterval, mapPaystackStatus } from '../src/lib/payments/paystackSubscriptions';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('subscriptions');

// ── PayFast ───────────────────────────────────────────────────────────────────
test('payfastFrequency maps month→3, year→6', () => {
  assert.equal(payfastFrequency('month'), 3);
  assert.equal(payfastFrequency('year'), 6);
});

test('m_payment_id prefix round-trips membership id', () => {
  assert.equal(isMembershipPaymentId('mem_abc-123'), true);
  assert.equal(isMembershipPaymentId('abc-123'), false);
  assert.equal(membershipIdFromPaymentId('mem_abc-123'), 'abc-123');
});

test('buildPayfastSubscriptionParams sets recurring fields + signed', () => {
  const p = buildPayfastSubscriptionParams(
    { id: 'm1', plan_name: 'Wellness', amount_zar: 500, billing_interval: 'month' },
    { name: 'Jane Doe', email: 'jane@example.com' },
    { merchant_id: '10000100', merchant_key: '46f0cd694581a', passphrase: 'secret' },
    'https://app.example.com',
  );
  assert.equal(p.subscription_type, '1');
  assert.equal(p.frequency, '3');
  assert.equal(p.cycles, '0');
  assert.equal(p.amount, '500.00');
  assert.equal(p.recurring_amount, '500.00');
  assert.equal(p.m_payment_id, 'mem_m1');
  assert.equal(p.name_first, 'Jane');
  assert.equal(p.name_last, 'Doe');
  assert.match(p.signature, /^[a-f0-9]{32}$/);
});

test('buildPayfastSubscriptionParams yearly → frequency 6', () => {
  const p = buildPayfastSubscriptionParams(
    { id: 'm2', plan_name: 'Annual', amount_zar: 4800, billing_interval: 'year' },
    {}, { merchant_id: 'x', merchant_key: 'y' }, 'https://a.b',
  );
  assert.equal(p.frequency, '6');
});

test('buildPayfastApiSignature is 32-hex and order-independent', () => {
  const a = buildPayfastApiSignature({ 'merchant-id': '100', version: 'v1', timestamp: '2026-06-27T10:00:00+02:00' }, 'pass');
  const b = buildPayfastApiSignature({ timestamp: '2026-06-27T10:00:00+02:00', version: 'v1', 'merchant-id': '100' }, 'pass');
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.equal(a, b); // sorted internally → key order doesn't matter
});

test('buildPayfastApiSignature changes with passphrase', () => {
  const base = { 'merchant-id': '100', version: 'v1', timestamp: '2026-06-27T10:00:00+02:00' };
  assert.notEqual(buildPayfastApiSignature(base, 'one'), buildPayfastApiSignature(base, 'two'));
});

test('buildPayfastSignature encodes spaces as + (sandbox-verified vector)', () => {
  // Frozen md5 confirmed accepted by PayFast's live sandbox. Guards against a
  // regression back to %20 encoding, which PayFast rejects for spaced values.
  const sig = buildPayfastSignature(
    { merchant_id: '10000100', amount: '500.00', item_name: 'Sandbox Wellness Plan' },
    'jt7NOE43FZPn',
  );
  assert.equal(sig, '282d0fed0fe96759ea65541c529d75d5');
});

test('payfastTimestamp is ISO8601 with +02:00 offset, no milliseconds', () => {
  const t = payfastTimestamp(new Date('2026-06-27T13:04:20.123Z'));
  assert.equal(t, '2026-06-27T15:04:20+02:00');
  assert.doesNotMatch(t, /\.\d{3}/);  // no milliseconds (PayFast rejects them)
  assert.doesNotMatch(t, /Z$/);       // numeric offset, not Z
});

test('mapPayfastStatus maps codes + words', () => {
  assert.equal(mapPayfastStatus('1'), 'active');
  assert.equal(mapPayfastStatus('active'), 'active');
  assert.equal(mapPayfastStatus('2'), 'cancelled');
  assert.equal(mapPayfastStatus('cancelled'), 'cancelled');
  assert.equal(mapPayfastStatus('3'), 'paused');
  assert.equal(mapPayfastStatus('complete'), 'cancelled');
  assert.equal(mapPayfastStatus('weird-unknown'), null); // unknown → don't guess (no fail-open)
  assert.equal(mapPayfastStatus(''), null);
});

// ── Paystack ──────────────────────────────────────────────────────────────────
test('paystackInterval maps month→monthly, year→annually', () => {
  assert.equal(paystackInterval('month'), 'monthly');
  assert.equal(paystackInterval('year'), 'annually');
});

test('mapPaystackStatus maps statuses', () => {
  assert.equal(mapPaystackStatus('active'), 'active');
  assert.equal(mapPaystackStatus('attention'), 'past_due');
  // 'non-renewing' = still active until the paid period ends (then → 'completed').
  assert.equal(mapPaystackStatus('non-renewing'), 'active');
  assert.equal(mapPaystackStatus('completed'), 'cancelled');
  assert.equal(mapPaystackStatus('cancelled'), 'cancelled');
  assert.equal(mapPaystackStatus('surprise-status'), null); // unknown → don't guess
});

console.log(`\n${passed} passed\n`);
