import crypto from 'node:crypto';
import type Stripe from 'stripe';
import { getStripe } from './stripe';
import { supabase } from './supabase';
import { createClinic, setClinicPlan, linkUserToClinic, getUserClinic } from '../db';
import { sendEmail } from './email';

const DASHBOARD_URL = (process.env.PUBLIC_BASE_URL || 'https://www.remireception.com') + '/app';

// Stripe product name → dashboard tier. Anything unrecognised falls back to the
// safest non-empty tier ('basic') rather than 'complete' (don't over-grant).
const PLAN_BY_PRODUCT: Record<string, string> = {
  'PaidUp — Invoice Chasing': 'paidup',
  'Remi — Basic': 'basic',
  'Remi — Standard': 'standard',
  'Remi — Complete': 'complete',
};
const PLAN_RANK = ['paidup', 'basic', 'standard', 'complete'];

/** Which tier a checkout's line items map to (highest, if more than one). */
async function planForSession(stripe: Stripe, sessionId: string): Promise<string> {
  const items = await stripe.checkout.sessions.listLineItems(sessionId, { expand: ['data.price.product'], limit: 10 });
  let best = '';
  for (const li of items.data) {
    const product = (li.price?.product as Stripe.Product | undefined);
    const plan = product?.name ? PLAN_BY_PRODUCT[product.name] : undefined;
    if (plan && (best === '' || PLAN_RANK.indexOf(plan) > PLAN_RANK.indexOf(best))) best = plan;
  }
  return best || 'basic';
}

/** Find an existing Supabase auth user by email (case-insensitive). */
async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const target = email.toLowerCase();
  // Paginate so we don't miss users beyond the first page.
  for (let page = 1; page <= 20; page++) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    const hit = users.find((u: any) => (u.email || '').toLowerCase() === target);
    if (hit) return { id: hit.id };
    if (users.length < 200) break;
  }
  return null;
}

function welcomeEmail(o: { name: string; plan: string; email: string; password?: string }) {
  const planLabel = o.plan === 'paidup' ? 'PaidUp' : `Remi ${o.plan[0].toUpperCase() + o.plan.slice(1)}`;
  const creds = o.password
    ? `<p style="margin:18px 0;padding:14px 16px;background:#f4f3ff;border-radius:10px;font-size:15px;line-height:1.8">
         <b>Your login</b><br>
         Dashboard: <a href="${DASHBOARD_URL}">${DASHBOARD_URL}</a><br>
         Email: <b>${o.email}</b><br>
         Temporary password: <b>${o.password}</b>
       </p>
       <p style="font-size:13px;color:#666">Please change your password after your first sign-in.</p>`
    : `<p style="margin:18px 0;font-size:15px">You can sign in at <a href="${DASHBOARD_URL}">${DASHBOARD_URL}</a> with your existing Remi login.</p>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="color:#7c6fea">Welcome to ${planLabel} 🎉</h2>
      <p style="font-size:15px;line-height:1.6">Hi ${o.name}, your subscription is active and your dashboard is ready.</p>
      ${creds}
      <p style="font-size:15px;line-height:1.6">Your 14-day free trial has started — you won't be charged until it ends, and you can cancel anytime.</p>
      <p style="font-size:14px;color:#666">Need a hand getting set up? Just reply to this email.</p>
      <p style="font-size:14px;margin-top:24px">— The Remi team</p>
    </div>`;
  const text = `Welcome to ${planLabel}!\n\nYour subscription is active.\n` +
    (o.password ? `\nDashboard: ${DASHBOARD_URL}\nEmail: ${o.email}\nTemporary password: ${o.password}\n(Please change it after first sign-in.)\n` : `\nSign in at ${DASHBOARD_URL} with your existing login.\n`) +
    `\nYour 14-day free trial has started. Cancel anytime.\n\n— The Remi team`;
  return { html, text, subject: `Your ${planLabel} dashboard is ready` };
}

/**
 * Provision a clinic + dashboard login from a completed Stripe Checkout. Safe to
 * call more than once for the same checkout (Stripe retries webhooks): if the
 * buyer already has a clinic, we just sync the plan and re-tag the subscription
 * and skip user creation + the welcome email.
 *
 * Returns a short status string for logging.
 */
export async function provisionFromCheckout(session: Stripe.Checkout.Session): Promise<string> {
  const email = (session.customer_details?.email || (session.customer_email ?? '')).trim().toLowerCase();
  if (!email) return 'no-email';
  const stripe = getStripe();

  const plan = await planForSession(stripe, session.id);
  const name = session.customer_details?.name || email.split('@')[0];
  const phone = session.customer_details?.phone || undefined;
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

  // Subscription status (e.g. 'trialing') so the dashboard reflects billing state.
  let subStatus = 'active';
  if (subscriptionId) {
    try { subStatus = (await stripe.subscriptions.retrieve(subscriptionId)).status; } catch { /* keep default */ }
  }

  // Is this buyer already a Remi user with a clinic? → idempotent re-sync.
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    const link = await getUserClinic(existingUser.id);
    if (link) {
      await setClinicPlan(link.clinic_id, plan);
      if (subscriptionId) await tagSubscription(stripe, subscriptionId, link.clinic_id);
      return `synced existing clinic ${link.clinic_id} → ${plan}`;
    }
  }

  // New clinic.
  const clinic = await createClinic({
    name,
    owner_summary_phone: phone,
    dashboard_token: crypto.randomBytes(12).toString('hex'),
    plan,
    subscription_status: subStatus,
  });
  if (subscriptionId) await tagSubscription(stripe, subscriptionId, clinic.id);

  // Dashboard login: reuse the existing auth user if there is one, else create.
  let userId: string;
  let password: string | undefined;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    password = crypto.randomBytes(9).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = data.user!.id;
  }
  await linkUserToClinic(userId, clinic.id, 'owner');

  try {
    const { html, text, subject } = welcomeEmail({ name, plan, email, password });
    await sendEmail({ to: email, toName: name, subject, html, text });
  } catch (e: any) {
    console.error('[provision] welcome email failed:', e?.message ?? e);
  }
  return `provisioned clinic ${clinic.id} → ${plan} (${existingUser ? 'existing user' : 'new user'})`;
}

/** Stamp clinic_id onto the subscription so future subscription.* events map back. */
async function tagSubscription(stripe: Stripe, subscriptionId: string, clinicId: string) {
  try { await stripe.subscriptions.update(subscriptionId, { metadata: { clinic_id: clinicId } }); }
  catch (e: any) { console.error('[provision] tag subscription failed:', e?.message ?? e); }
}
