// Payment-link logic tests. Run: tsx tests/payments.test.ts
import assert from 'node:assert';
import { buildPayfastSignature, buildPayfastParams, validatePayfastNotify } from '../src/lib/payments/payfast';
import { getPaymentProvider, payUrlForInvoice } from '../src/lib/payments';
import { verifyPaystackWebhook } from '../src/lib/payments/paystack';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('payment links');

// ── PayFast signature ────────────────────────────────────────────────────────
test('buildPayfastSignature is a 32-char md5 and order/passphrase sensitive', () => {
  const a = buildPayfastSignature({ merchant_id: '1', amount: '100.00', item_name: 'X' });
  assert.match(a, /^[a-f0-9]{32}$/);
  const withPass = buildPayfastSignature({ merchant_id: '1', amount: '100.00', item_name: 'X' }, 'secret');
  assert.notEqual(a, withPass);
});
test('buildPayfastSignature ignores an existing signature field', () => {
  const params = { merchant_id: '1', amount: '50.00' };
  const sig = buildPayfastSignature(params);
  assert.equal(buildPayfastSignature({ ...params, signature: 'whatever' }), sig);
});

// ── PayFast params + round-trip validation ───────────────────────────────────
test('buildPayfastParams produces a valid, self-consistent signature', () => {
  const params = buildPayfastParams(
    { id: 'inv-1', invoice_number: 'INV-1', contact_name: 'Sipho Dlamini', contact_email: 's@x.co.za', amount_due: 2500 },
    { merchant_id: '10000100', merchant_key: '46f0cd694581a', passphrase: 'jt7NOE43FZPn' },
    'https://www.remireception.com',
  );
  assert.equal(params.amount, '2500.00');
  assert.equal(params.m_payment_id, 'inv-1');
  assert.equal(params.name_first, 'Sipho');
  assert.equal(params.name_last, 'Dlamini');
  assert.ok(params.notify_url.endsWith('/webhooks/payfast'));
  // The ITN validator should accept the params we just signed.
  assert.equal(validatePayfastNotify(params, 'jt7NOE43FZPn'), true);
  // Wrong passphrase → rejected.
  assert.equal(validatePayfastNotify(params, 'wrong'), false);
});
test('validatePayfastNotify rejects a body with no signature', () => {
  assert.equal(validatePayfastNotify({ m_payment_id: 'x' }), false);
});

// ── provider selection ───────────────────────────────────────────────────────
test('getPaymentProvider only returns a provider when fully configured', () => {
  assert.equal(getPaymentProvider({ payment_provider: 'payfast', payment_config: { payfast: { merchant_id: '1', merchant_key: '2' } } }), 'payfast');
  assert.equal(getPaymentProvider({ payment_provider: 'payfast', payment_config: { payfast: { merchant_id: '1' } } }), null); // missing key
  assert.equal(getPaymentProvider({ payment_provider: 'paystack', payment_config: { paystack: { secret_key: 'sk' } } }), 'paystack');
  assert.equal(getPaymentProvider({ payment_provider: 'stripe', payment_config: { stripe: { secret_key: 'sk_live' } } }), 'stripe');
  assert.equal(getPaymentProvider({ payment_provider: 'stripe', payment_config: { stripe: {} } }), null); // missing key
  assert.equal(getPaymentProvider({ payment_provider: 'paypal', payment_config: { paypal: { client_id: 'c', secret: 's' } } }), 'paypal');
  assert.equal(getPaymentProvider({ payment_provider: 'paypal', payment_config: { paypal: { client_id: 'c' } } }), null); // missing secret
  assert.equal(getPaymentProvider({ payment_provider: 'link', payment_config: { link: { url: 'https://x' } } }), 'link');
  assert.equal(getPaymentProvider({ payment_provider: null }), null);
  assert.equal(getPaymentProvider(null), null);
});
test('payUrlForInvoice builds a /pay/<id> URL', () => {
  assert.ok(payUrlForInvoice('abc-123').endsWith('/pay/abc-123'));
});

// ── Paystack webhook ─────────────────────────────────────────────────────────
test('verifyPaystackWebhook accepts a correct HMAC, rejects a wrong one', () => {
  const crypto = require('node:crypto');
  const raw = JSON.stringify({ event: 'charge.success' });
  const sig = crypto.createHmac('sha512', 'sk_test').update(raw).digest('hex');
  assert.equal(verifyPaystackWebhook(raw, sig, 'sk_test'), true);
  assert.equal(verifyPaystackWebhook(raw, sig, 'wrong'), false);
  assert.equal(verifyPaystackWebhook(raw, '', 'sk_test'), false);
});

console.log(`\n${passed} payment tests passed ✅`);
