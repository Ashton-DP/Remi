// Creates Remi's 3 subscription tiers (products + recurring ZAR prices + Payment
// Links) in YOUR Stripe account. Run ONCE: node --env-file=.env scripts/setupStripePlans.mjs
// (re-running creates duplicates). Requires STRIPE_SECRET_KEY in .env.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Missing STRIPE_SECRET_KEY in .env'); process.exit(1); }
const stripe = new Stripe(key);
console.log(`Using Stripe key: ${key.startsWith('sk_live') ? 'LIVE 🔴 (will create real products)' : 'TEST 🧪'}`);

const TIERS = [
  {
    name: 'Remi — Starter',
    zar: 2500,
    desc: 'Your 24/7 WhatsApp receptionist — answers enquiries, books & reschedules appointments, sends no-show reminders, backfills cancellations from a waitlist, and a monthly revenue-recovered report.',
  },
  {
    name: 'Remi — Standard',
    zar: 4500,
    desc: 'Everything in Starter, plus a 24/7 AI voice receptionist that answers your phone, instant missed-call → WhatsApp recovery, and a live booking dashboard.',
  },
  {
    name: 'Remi — Premium',
    zar: 6500,
    desc: 'The complete AI front desk — everything in Standard, plus booking deposits, automatic review requests, lapsed-patient reactivation, a daily revenue report, a custom brand voice & persona, multi-location support, and priority direct support.',
  },
];

async function main() {
  console.log('\nCreating tiers…\n');
  for (const t of TIERS) {
    const product = await stripe.products.create({ name: t.name, description: t.desc });
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'zar',
      unit_amount: t.zar * 100,
      recurring: { interval: 'month' },
    });
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
    });
    console.log(`${t.name}  (R${t.zar}/mo)`);
    console.log(`  ${link.url}\n`);
  }
  console.log('Done. Send the matching link to each clinic — payments land in your Stripe.');
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
