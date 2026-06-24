// Creates 14-day-free-trial Payment Links for the EXISTING Remi tiers (matches
// the website's "Free 2-week trial" promise). Reuses the products/prices made by
// setupStripePlans.mjs — does NOT create new products. Safe to re-run (it just
// makes fresh links). Run: node --env-file=.env scripts/createTrialLinks.mjs
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Missing STRIPE_SECRET_KEY in .env'); process.exit(1); }
const stripe = new Stripe(key);
console.log(`Using Stripe key: ${key.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST 🧪'}`);

const TRIAL_DAYS = 14;
const WANT = ['PaidUp — Invoice Chasing', 'Remi — Basic', 'Remi — Standard', 'Remi — Complete'];

async function main() {
  const products = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) products.push(p);

  console.log(`\n${TRIAL_DAYS}-day free-trial links:\n`);
  for (const name of WANT) {
    const product = products.find((p) => p.name === name);
    if (!product) { console.error(`⚠️  product not found: ${name} (run setupStripePlans.mjs first)`); continue; }
    const prices = (await stripe.prices.list({ product: product.id, active: true })).data
      .filter((pr) => pr.recurring);
    if (!prices.length) { console.error(`⚠️  no recurring price for ${name}`); continue; }
    const price = prices[0];
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
    });
    const zar = (price.unit_amount / 100).toLocaleString('en-ZA');
    console.log(`${name}  (R${zar}/mo · ${TRIAL_DAYS}-day trial)`);
    console.log(`  ${link.url}\n`);
  }
  console.log('Card is collected up front; first charge is after the trial. Cancel-anytime.');
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
