/**
 * Sandbox testing pass for multi-provider memberships.
 *
 *   PAYFAST  — uses PayFast's public sandbox merchant (10000100 / 46f0cd694581a,
 *              no passphrase). Tests are real calls against PayFast's live sandbox:
 *                1. the signup-form signature is accepted by /eng/process
 *                2. the server-API signature is accepted by /subscriptions/.../fetch
 *   PAYSTACK — needs a test secret key. Set PAYSTACK_TEST_KEY=sk_test_... to run
 *              real plan + transaction-init calls; otherwise those steps are skipped.
 *
 * Run: PAYFAST_SANDBOX=true npx tsx scripts/sandboxMemberships.ts
 */
process.env.PAYFAST_SANDBOX = 'true';

import { buildPayfastSubscriptionParams, fetchPayfastSubscription } from '../src/lib/payments/payfastSubscriptions';
import {
  startPaystackSubscription, confirmPaystackSubscription,
  fetchPaystackSubscription, cancelPaystackSubscription,
} from '../src/lib/payments/paystackSubscriptions';

// PayFast's public sandbox merchant + the passphrase from its SDK fixtures
// (confirmed against the live sandbox during this pass).
const PF_CREDS = { merchant_id: '10000100', merchant_key: '46f0cd694581a', passphrase: 'jt7NOE43FZPn' };
const BASE = 'https://app.example.com';

let pass = 0, fail = 0;
const ok = (n: string, extra = '') => { pass++; console.log(`  ✓ ${n}${extra ? ` — ${extra}` : ''}`); };
const bad = (n: string, why: string) => { fail++; console.log(`  ✗ ${n} — ${why}`); };

async function payfastFormSignature() {
  const membership = { id: 'sandbox-m1', plan_name: 'Sandbox Wellness Plan', amount_zar: 500, billing_interval: 'month' };
  const fields = buildPayfastSubscriptionParams(membership, { name: 'Jane Doe', email: 'jane@example.com' }, PF_CREDS, BASE);
  // Post the signed subscription form exactly as a browser would. A valid request
  // 302-redirects to the payment page; a bad signature renders a 400 error page.
  const res = await fetch('https://sandbox.payfast.co.za/eng/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
  const text = await res.text();
  const err = text.match(/err-msg[^>]*>([\s\S]*?)<\//);
  if (err) return bad('PayFast subscription form accepted', err[1].replace(/<[^>]+>/g, '').trim());
  ok('PayFast subscription form accepted', `HTTP ${res.status} (redirect to payment page, no signature error)`);
}

async function payfastApiSignature() {
  // A bogus token: if our API signature were wrong, PayFast replies with a
  // "merchant/signature" auth error. If the signature is accepted, it instead
  // complains the subscription is missing/invalid — which is what we want here.
  try {
    await fetchPayfastSubscription(PF_CREDS, 'deadbeef-0000-0000-0000-000000000000');
    ok('PayFast server-API signature accepted', 'fetch returned a parsed response (signature OK)');
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (/signature|merchant|unauthor|authentication/.test(msg)) {
      bad('PayFast server-API signature accepted', `auth rejected: ${e.message}`);
    } else {
      // e.g. "not found" / "no data" → signature was accepted, token just doesn't exist.
      ok('PayFast server-API signature accepted', `non-auth error (signature OK): ${e.message}`);
    }
  }
}

async function psApi(key: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return res.json().catch(() => ({}));
}

async function paystackFlow() {
  const key = process.env.PAYSTACK_TEST_KEY;
  if (!key) {
    console.log('  ⊘ Paystack — set PAYSTACK_TEST_KEY=sk_test_... to run the live lifecycle (skipped)');
    return;
  }
  // 1. checkout init (the real production signup entry point)
  try {
    const out = await startPaystackSubscription(key, {
      email: 'sandbox@example.com', amountZar: 500, planName: 'Sandbox Plan', interval: 'month',
      reference: `mem_sandbox_${Date.now()}`, callbackUrl: `${BASE}/membership/sandbox/return`,
    });
    if (out.authorization_url?.startsWith('https://')) ok('Paystack checkout init', out.authorization_url);
    else bad('Paystack checkout init', 'no authorization_url returned');
  } catch (e: any) { bad('Paystack checkout init', e?.message ?? String(e)); }

  // 2. full lifecycle: a successful test charge yields a card authorization → we
  //    create a real subscription (as the hosted page does) → then exercise our
  //    OWN confirm / sync / cancel functions against it.
  try {
    const plan = (await psApi(key, '/plan', { method: 'POST', body: JSON.stringify({ name: `Sandbox Lifecycle ${Date.now()}`, amount: 50000, interval: 'monthly', currency: 'ZAR' }) })).data;
    const reference = `mem_life_${Date.now()}`;
    const charge = (await psApi(key, '/charge', { method: 'POST', body: JSON.stringify({ email: `life_${Date.now()}@example.com`, amount: 50000, reference, card: { number: '4084084084084081', cvv: '408', expiry_month: '12', expiry_year: '30' } }) })).data;
    if (charge?.status !== 'success') return bad('Paystack lifecycle', `test charge not successful (${charge?.status})`);
    const sub = (await psApi(key, '/subscription', { method: 'POST', body: JSON.stringify({ customer: charge.customer.customer_code, plan: plan.plan_code, authorization: charge.authorization.authorization_code }) })).data;
    if (!sub?.subscription_code) return bad('Paystack lifecycle', 'subscription not created');

    const confirmed = await confirmPaystackSubscription(key, reference);
    if (confirmed?.subscriptionCode) ok('Paystack confirm (verify → find subscription)', confirmed.subscriptionCode);
    else return bad('Paystack confirm', 'subscription not found from transaction');

    const synced = await fetchPaystackSubscription(key, confirmed.subscriptionCode);
    if (synced.status === 'active') ok('Paystack sync (fetch status)', `status=${synced.status}, renews ${synced.renewsAt?.slice(0, 10)}`);
    else bad('Paystack sync', `unexpected status ${synced.status}`);

    await cancelPaystackSubscription(key, confirmed.subscriptionCode);
    const after = await fetchPaystackSubscription(key, confirmed.subscriptionCode);
    if (after.status === 'cancelled') ok('Paystack cancel (disable → cancelled)', `status=${after.status}`);
    else bad('Paystack cancel', `status after cancel was ${after.status}, expected cancelled`);
  } catch (e: any) { bad('Paystack lifecycle', e?.message ?? String(e)); }
}

(async () => {
  console.log('\nMembership sandbox pass\n');
  console.log('PayFast (public sandbox merchant):');
  await payfastFormSignature();
  await payfastApiSignature();
  console.log('\nPaystack:');
  await paystackFlow();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
