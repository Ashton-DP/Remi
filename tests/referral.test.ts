// Referral attribution pure logic. Run: tsx tests/referral.test.ts
import assert from 'node:assert';
import { generateReferralCode, extractReferralCode, buildReferralShareLink } from '../src/lib/referral';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('referral attribution');

test('generateReferralCode: REF- + 5 unambiguous chars, unique-ish', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = generateReferralCode();
    assert.match(c, /^REF-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    codes.add(c);
  }
  assert.ok(codes.size > 190, `expected near-unique codes, got ${codes.size}/200`);
});

test('extractReferralCode: pulls the code from a real message', () => {
  assert.equal(extractReferralCode("Hi! I'd like to book — Jane referred me (ref:REF-7K3QP)"), 'REF-7K3QP');
  assert.equal(extractReferralCode('referred by Sipho REF-AB2CD please'), 'REF-AB2CD');
  assert.equal(extractReferralCode('my code is ref: REF-9MNPQ'), 'REF-9MNPQ');
});

test('extractReferralCode: case-insensitive, returns uppercase', () => {
  assert.equal(extractReferralCode('ref:ref-7k3qp'), 'REF-7K3QP');
});

test('extractReferralCode: null when no code present', () => {
  assert.equal(extractReferralCode('Hi, can I book a facial on Friday?'), null);
  assert.equal(extractReferralCode(''), null);
});

test('buildReferralShareLink: wa.me with digits-only number + encoded code', () => {
  const link = buildReferralShareLink('+27 60 015 1104', 'Jane', 'REF-7K3QP');
  assert.ok(link.startsWith('https://wa.me/27600151104?text='));
  assert.ok(decodeURIComponent(link).includes('ref:REF-7K3QP'));
  assert.ok(decodeURIComponent(link).includes('Jane referred me'));
});

console.log(`\n${passed} passed\n`);
