// Archive the DUPLICATE Remi product set. The canonical set uses an em-dash
// ("Remi — Starter"); an earlier manual set uses a plain hyphen ("Remi - Starter").
// This archives the hyphen set + deactivates any Payment Links pointing at it.
// Run: node --env-file=.env scripts/cleanupStripeDuplicates.mjs
import Stripe from 'stripe';
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Missing STRIPE_SECRET_KEY'); process.exit(1); }
const stripe = new Stripe(key);

const isDuplicate = (name) => /^Remi\s-\s/.test(name);   // hyphen-space, NOT em-dash

async function main() {
  // Collect product ids of the duplicate (hyphen) set
  const dupIds = new Set();
  const prods = await stripe.products.list({ limit: 100, active: true });
  for (const p of prods.data) {
    if (/^remi/i.test(p.name) && isDuplicate(p.name)) dupIds.add(p.id);
  }

  // 1) Deactivate any payment links that point at a duplicate product
  const links = await stripe.paymentLinks.list({ limit: 100, active: true });
  for (const l of links.data) {
    const items = await stripe.paymentLinks.listLineItems(l.id, { limit: 20, expand: ['data.price'] });
    const pointsToDup = items.data.some((it) => {
      const prod = it.price?.product;
      return prod && dupIds.has(typeof prod === 'string' ? prod : prod.id);
    });
    if (pointsToDup) {
      await stripe.paymentLinks.update(l.id, { active: false });
      console.log(`DEACTIVATED LINK ${l.url}`);
    }
  }

  // 2) Archive the duplicate products (archiving the product is enough; leave
  //    the default price alone — Stripe blocks archiving a default price).
  for (const p of prods.data) {
    if (!/^remi/i.test(p.name)) continue;
    if (isDuplicate(p.name)) {
      await stripe.products.update(p.id, { active: false });
      console.log(`ARCHIVED ${p.name}`);
    } else {
      console.log(`KEEP     ${p.name}`);
    }
  }
  console.log('\nDone. Refresh Stripe — only the em-dash "Remi — X" set should remain.');
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
