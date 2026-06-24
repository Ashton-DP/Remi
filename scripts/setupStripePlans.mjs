// Creates Remi's subscription tiers (products + recurring ZAR prices + Payment
// Links) in YOUR Stripe account. Run ONCE: node --env-file=.env scripts/setupStripePlans.mjs
// (re-running creates duplicates — use cleanupStripeDuplicates.mjs to clear them).
// Requires STRIPE_SECRET_KEY in .env. "Remi for Chains" is custom-quoted, so it
// has no fixed link and is intentionally omitted.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Missing STRIPE_SECRET_KEY in .env'); process.exit(1); }
const stripe = new Stripe(key);
console.log(`Using Stripe key: ${key.startsWith('sk_live') ? 'LIVE 🔴 (will create real products)' : 'TEST 🧪'}`);

const TIERS = [
  {
    name: 'PaidUp — Invoice Chasing',
    zar: 299,
    desc: 'Automated invoice chasing — Remi politely follows up your overdue invoices over WhatsApp & email until you are paid, with one-tap payment links and reply handling. Connects to Xero, QuickBooks, Sage or a Google Sheet.',
  },
  {
    name: 'Remi — Basic',
    zar: 990,
    desc: 'Bookings, handled. Your AI receptionist takes bookings, reschedules and cancellations 24/7 over WhatsApp, and sends automatic no-show reminders. The simplest way to stop losing appointments.',
  },
  {
    name: 'Remi — Standard',
    zar: 2900,
    desc: 'The full AI receptionist — answers your phone and WhatsApp 24/7, books and reschedules, instantly recovers missed calls, and gives you a live dashboard plus a daily brief. A fraction of a front-desk salary.',
  },
  {
    name: 'Remi — Complete',
    zar: 6500,
    desc: 'The whole front office — everything in Standard, plus invoice chasing (Get Paid built in), lapsed-customer reactivation, automatic review requests, multi-location support, a custom brand voice & persona, and priority support.',
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
  console.log('Remi for Chains is custom-quoted — no fixed link.');
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
