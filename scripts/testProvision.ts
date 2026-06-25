/**
 * End-to-end provisioning smoke test (no card needed).
 *
 *   tsx scripts/testProvision.ts            # create a real Basic checkout session,
 *                                           # run provisionFromCheckout, verify, set
 *                                           # a known password, write creds to Desktop
 *   tsx scripts/testProvision.ts cleanup    # delete the test clinic + login + link
 *
 * Runs against LIVE Stripe + LIVE Supabase (reads keys from .env). Uses a
 * plus-addressed test email so it never collides with a real login, and the
 * cleanup step removes everything it created.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStripe } from '../src/lib/stripe';
import { provisionFromCheckout } from '../src/lib/provisionClinic';
import { supabase } from '../src/lib/supabase';
import { getUserClinic } from '../src/db';

const TEST_EMAIL = 'ashtondepontes2000+remitest@gmail.com';
const PRODUCT_NAME = 'Remi — Basic';
const EXPECT_PLAN = 'basic';
const credsFile = path.join(os.homedir(), 'Desktop', 'remi-provision-test.txt');

async function findUser(email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    const hit = users.find((u: any) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (users.length < 200) break;
  }
  return null;
}

async function provision() {
  const stripe = getStripe();
  console.log('1. Finding the Basic product/price…');
  const products: any[] = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) products.push(p);
  const product = products.find((p) => p.name === PRODUCT_NAME);
  if (!product) throw new Error(`product "${PRODUCT_NAME}" not found`);
  const price = (await stripe.prices.list({ product: product.id, active: true })).data.find((pr) => pr.recurring);
  if (!price) throw new Error('no recurring price on Basic');

  console.log('2. Creating a real (subscription) Checkout Session with line items…');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    customer_email: TEST_EMAIL,
    subscription_data: { trial_period_days: 14 },
    success_url: 'https://www.remireception.com/app',
    cancel_url: 'https://www.remireception.com',
  });
  console.log(`   session ${session.id} (mode=${session.mode})`);

  console.log('3. Running provisionFromCheckout() — the exact code the webhook calls…');
  const result = await provisionFromCheckout(session);
  console.log(`   → ${result}`);

  console.log('4. Verifying the data landed correctly…');
  const user = await findUser(TEST_EMAIL);
  if (!user) throw new Error('FAIL: no auth user created');
  const link = await getUserClinic(user.id);
  if (!link) throw new Error('FAIL: user not linked to a clinic');
  const { data: clinic } = await supabase.from('clinics').select('id,name,plan,subscription_status').eq('id', link.clinic_id).single();
  console.log(`   user:   ${user.email} (${user.id})`);
  console.log(`   role:   ${link.role}`);
  console.log(`   clinic: ${clinic?.name} (${clinic?.id})`);
  console.log(`   plan:   ${clinic?.plan}   [expected ${EXPECT_PLAN}]`);
  console.log(`   status: ${clinic?.subscription_status}`);

  const planOk = clinic?.plan === EXPECT_PLAN;
  const roleOk = link.role === 'owner';
  console.log(`\n   PLAN ROUTING: ${planOk ? '✅ PASS' : '❌ FAIL'}   OWNER LINK: ${roleOk ? '✅ PASS' : '❌ FAIL'}`);

  console.log('5. Setting a known password so you can sign in and SEE the dashboard…');
  const password = crypto.randomBytes(9).toString('base64url');
  await supabase.auth.admin.updateUserById(user.id, { password, email_confirm: true });
  fs.writeFileSync(credsFile,
    `Remi PROVISION TEST login (delete after)\n========================================\n` +
    `URL:      https://www.remireception.com/app\n` +
    `Email:    ${TEST_EMAIL}\nPassword: ${password}\n` +
    `Plan:     ${clinic?.plan}\nClinic:   ${clinic?.id}\n\n` +
    `Expect to see the BASIC dashboard: Appointments, Team, Settings only.\n` +
    `When done, run: tsx scripts/testProvision.ts cleanup\n`);
  console.log(`   credentials written to ${credsFile}`);
  console.log('\nDONE. Sign in and confirm you see ONLY Appointments + Team + Settings.');
}

async function cleanup() {
  const user = await findUser(TEST_EMAIL);
  if (!user) { console.log('Nothing to clean — no test user found.'); return; }
  const link = await getUserClinic(user.id);
  if (link?.clinic_id) {
    await supabase.from('clinic_users').delete().eq('clinic_id', link.clinic_id);
    await supabase.from('clinics').delete().eq('id', link.clinic_id);
    console.log(`• deleted clinic ${link.clinic_id} + its links`);
  }
  await supabase.auth.admin.deleteUser(user.id);
  console.log(`• deleted auth user ${user.email}`);
  try { fs.unlinkSync(credsFile); } catch { /* ignore */ }
  console.log('Cleanup complete.');
}

const mode = process.argv[2] === 'cleanup' ? cleanup : provision;
mode().catch((e) => { console.error('❌', e.message); process.exit(1); });
