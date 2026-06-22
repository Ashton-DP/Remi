// Create a per-clinic Stripe subscription Payment Link that carries the clinic_id
// in the subscription metadata, so the /webhooks/stripe handler can map payments
// to the right clinic (updates clinics.subscription_status). Includes a 2-week
// free trial to match the Remi offer.
//
// Run: node --env-file=.env scripts/createClinicSubscriptionLink.mjs <tier> <clinic_id> [trialDays]
//   tier = starter | standard | premium
// Requires STRIPE_SECRET_KEY in .env.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Missing STRIPE_SECRET_KEY in .env'); process.exit(1); }
const stripe = new Stripe(key);

const [, , tierArg, clinicId, trialArg] = process.argv;
const tier = String(tierArg || '').toLowerCase();
const trialDays = Number(trialArg ?? 14);
if (!['starter', 'standard', 'premium'].includes(tier) || !clinicId) {
  console.error('Usage: node --env-file=.env scripts/createClinicSubscriptionLink.mjs <starter|standard|premium> <clinic_id> [trialDays]');
  process.exit(1);
}

async function main() {
  // Find the canonical em-dash product for this tier and its recurring price.
  const products = await stripe.products.list({ limit: 100, active: true });
  const re = new RegExp(`^Remi\\s—\\s${tier}`, 'i');
  const product = products.data.find((p) => re.test(p.name));
  if (!product) throw new Error(`No active product matching "Remi — ${tier}". Run setupStripePlans.mjs first.`);

  let priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
  if (!priceId) {
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 1 });
    priceId = prices.data[0]?.id;
  }
  if (!priceId) throw new Error(`No price found for ${product.name}`);

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      metadata: { clinic_id: clinicId },          // ← webhook reads this
      trial_period_days: trialDays > 0 ? trialDays : undefined,
    },
    metadata: { clinic_id: clinicId, tier },
  });

  console.log(`\n✅ Per-clinic ${tier} link created`);
  console.log(`   product:  ${product.name}`);
  console.log(`   clinic:   ${clinicId}`);
  console.log(`   trial:    ${trialDays} days`);
  console.log(`   LINK →    ${link.url}\n`);
  console.log('Send this link to the clinic. When they subscribe, the Stripe webhook');
  console.log('will set their clinics.subscription_status automatically.');
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
