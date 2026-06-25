import type Stripe from 'stripe';
import { getStripe } from './stripe';
import { setClinicSubscriptionStatus } from '../db';
import { sendEmail } from './email';

const SITE = process.env.PUBLIC_BASE_URL || 'https://www.remireception.com';
const DASHBOARD_URL = SITE + '/app';

function subId(sub: string | Stripe.Subscription | null | undefined): string | undefined {
  return typeof sub === 'string' ? sub : sub?.id;
}

/** Resolve the clinic this subscription belongs to (via its clinic_id metadata). */
async function clinicForSubscription(stripe: Stripe, id?: string): Promise<string | null> {
  if (!id) return null;
  try { return (await stripe.subscriptions.retrieve(id)).metadata?.clinic_id ?? null; }
  catch { return null; }
}

function emailShell(title: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="color:#7c6fea">${title}</h2>
      ${bodyHtml}
      <p style="font-size:14px;color:#666;margin-top:18px">Questions? Just reply to this email.</p>
      <p style="font-size:14px;margin-top:18px">— The Remi team</p>
    </div>`;
}

/**
 * customer.subscription.trial_will_end — fires ~3 days before a trial ends.
 * Nudge the clinic so the trial→paid conversion isn't a surprise. We only nudge
 * subscriptions still in 'trialing' (if it's already active/paid, nothing to say).
 */
export async function onTrialWillEnd(sub: Stripe.Subscription) {
  const stripe = getStripe();
  if (sub.status !== 'trialing') return; // already converted/collected — skip
  const clinicId = sub.metadata?.clinic_id ?? null;

  // Get the billing contact from the customer record.
  let email: string | null = null;
  let name = 'there';
  try {
    const cust = await stripe.customers.retrieve(typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
    if (!('deleted' in cust)) { email = cust.email ?? null; name = cust.name?.split(' ')[0] || name; }
  } catch { /* fall through */ }
  if (!email) { console.log(`[billing] trial_will_end for clinic ${clinicId ?? '?'} — no email on customer`); return; }

  const endsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' }) : 'in a few days';
  const html = emailShell('Your Remi trial ends soon', `
    <p style="font-size:15px;line-height:1.6">Hi ${name}, your free trial ends on <b>${endsAt}</b>. After that your subscription continues automatically and your card is charged — nothing for you to do if you'd like to keep going.</p>
    <p style="font-size:15px;line-height:1.6">Everything you've set up stays exactly as it is. You can manage or cancel anytime from your <a href="${DASHBOARD_URL}">dashboard</a>.</p>`);
  const text = `Hi ${name},\n\nYour Remi free trial ends on ${endsAt}. After that your subscription continues automatically — nothing to do if you'd like to keep going. Manage or cancel anytime: ${DASHBOARD_URL}\n\n— The Remi team`;
  await sendEmail({ to: email, toName: name, subject: 'Your Remi trial ends soon', html, text });
  console.log(`[billing] trial_will_end nudge sent → clinic ${clinicId ?? '?'}`);
}

/**
 * invoice.payment_failed — a renewal card was declined. Mark the clinic past_due
 * and email the billing contact to update their card before Stripe gives up.
 */
export async function onPaymentFailed(invoice: Stripe.Invoice) {
  const stripe = getStripe();
  const clinicId = await clinicForSubscription(stripe, subId((invoice as any).subscription));
  if (clinicId) {
    try { await setClinicSubscriptionStatus(clinicId, 'past_due'); }
    catch (e: any) { console.error('[billing] past_due update failed', e?.message ?? e); }
  }

  const email = invoice.customer_email;
  if (email) {
    const name = invoice.customer_name?.split(' ')[0] || 'there';
    const amount = invoice.amount_due ? 'R' + (invoice.amount_due / 100).toLocaleString('en-ZA') : 'your subscription';
    const html = emailShell("Your Remi payment didn't go through", `
      <p style="font-size:15px;line-height:1.6">Hi ${name}, we tried to charge ${amount} for your Remi subscription but the payment was declined.</p>
      <p style="font-size:15px;line-height:1.6">Stripe will retry automatically, but the quickest fix is to update your card. ${invoice.hosted_invoice_url ? `<a href="${invoice.hosted_invoice_url}">Update payment &amp; pay now →</a>` : `You can update it from your <a href="${DASHBOARD_URL}">dashboard</a>.`}</p>
      <p style="font-size:14px;color:#666">Remi keeps running for now — we just wanted to flag it so there's no interruption.</p>`);
    const text = `Hi ${name},\n\nWe tried to charge ${amount} for your Remi subscription but the payment was declined. ` +
      (invoice.hosted_invoice_url ? `Update your card and pay here: ${invoice.hosted_invoice_url}` : `Update it from your dashboard: ${DASHBOARD_URL}`) +
      `\n\n— The Remi team`;
    try { await sendEmail({ to: email, toName: invoice.customer_name ?? undefined, subject: "Your Remi payment didn't go through", html, text }); }
    catch (e: any) { console.error('[billing] payment_failed email failed', e?.message ?? e); }
  }
  console.log(`[billing] payment_failed handled → clinic ${clinicId ?? '?'}`);
}

/**
 * invoice.paid — a renewal succeeded. Stripe sends its own receipt, so this is
 * mainly an ops log; we also re-assert the live status from the subscription so
 * a clinic that was past_due flips back to active on recovery.
 */
export async function onInvoicePaid(invoice: Stripe.Invoice) {
  const stripe = getStripe();
  const sid = subId((invoice as any).subscription);
  if (!sid) return; // one-off invoice, not a subscription renewal
  let clinicId: string | null = null;
  let status = 'active';
  try {
    const sub = await stripe.subscriptions.retrieve(sid);
    clinicId = sub.metadata?.clinic_id ?? null;
    status = sub.status;
  } catch { /* keep defaults */ }
  if (clinicId) {
    try { await setClinicSubscriptionStatus(clinicId, status); } catch { /* non-fatal */ }
  }
  const amount = invoice.amount_paid ? 'R' + (invoice.amount_paid / 100).toLocaleString('en-ZA') : '';
  console.log(`[billing] invoice paid ${amount} → clinic ${clinicId ?? '?'} (${status})`);
}
