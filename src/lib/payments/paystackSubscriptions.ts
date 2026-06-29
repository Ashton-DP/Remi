/**
 * Paystack recurring billing (Plans + Subscriptions), ZAR. Per-clinic secret key.
 *
 * Signup: create a Plan (amount + interval) → initialise a transaction that
 * references the plan → the client pays on Paystack's page → Paystack creates the
 * subscription. We confirm on the return trip (verify transaction → look up the
 * subscription it created) and reconcile daily via the Subscriptions API.
 */
import type { MembershipStatus } from '../clientOs';

const API = 'https://api.paystack.co';

async function paystack(secretKey: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === false) throw new Error(data?.message || `Paystack ${res.status}`);
  return data.data;
}

/** Our interval → Paystack interval string. Pure. */
export function paystackInterval(interval: 'month' | 'year'): 'monthly' | 'annually' {
  return interval === 'year' ? 'annually' : 'monthly';
}

/** Create a recurring Plan and start a checkout transaction tied to it.
 *  Returns the hosted authorization URL to redirect the client to. */
export async function startPaystackSubscription(secretKey: string, o: {
  email: string; amountZar: number; planName: string; interval: 'month' | 'year';
  reference: string; callbackUrl: string;
}): Promise<{ authorization_url: string }> {
  const plan = await paystack(secretKey, '/plan', {
    method: 'POST',
    body: JSON.stringify({
      name: o.planName,
      amount: Math.round(o.amountZar * 100), // minor units
      interval: paystackInterval(o.interval),
      currency: 'ZAR',
    }),
  });
  const tx = await paystack(secretKey, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: o.email,
      amount: Math.round(o.amountZar * 100),
      plan: plan.plan_code,
      reference: o.reference,
      callback_url: o.callbackUrl,
    }),
  });
  return { authorization_url: tx.authorization_url };
}

/** After the client returns, verify the transaction and find the subscription it
 *  created. Returns the subscription code + next payment date, or null if not paid. */
export async function confirmPaystackSubscription(
  secretKey: string, reference: string,
): Promise<{ subscriptionCode: string; renewsAt: string | null } | null> {
  const tx = await paystack(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);
  if (tx?.status !== 'success') return null;
  const customerId = tx?.customer?.id ?? tx?.customer?.customer_code;
  const planId = tx?.plan?.id ?? tx?.plan;
  // List the customer's subscriptions and pick the one for this plan (most recent).
  const subs = await paystack(secretKey, `/subscription?customer=${encodeURIComponent(String(customerId))}`);
  const list: any[] = Array.isArray(subs) ? subs : [];
  const match = list
    .filter((s) => !planId || s?.plan?.id === planId || s?.plan?.plan_code === planId)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0] ?? list[0];
  if (!match?.subscription_code) return null;
  return { subscriptionCode: match.subscription_code, renewsAt: match.next_payment_date ?? null };
}

/** Fetch a subscription's status + next payment date (daily sync). */
export async function fetchPaystackSubscription(
  secretKey: string, code: string,
): Promise<{ status: MembershipStatus | null; renewsAt: string | null }> {
  const s = await paystack(secretKey, `/subscription/${encodeURIComponent(code)}`);
  return { status: mapPaystackStatus(s?.status), renewsAt: s?.next_payment_date ?? null };
}

/** Cancel (disable) a subscription. Needs the email_token, fetched from the sub. */
export async function cancelPaystackSubscription(secretKey: string, code: string): Promise<void> {
  const s = await paystack(secretKey, `/subscription/${encodeURIComponent(code)}`);
  const token = s?.email_token;
  if (!token) throw new Error('Paystack: subscription email_token not found');
  await paystack(secretKey, '/subscription/disable', {
    method: 'POST',
    body: JSON.stringify({ code, token }),
  });
}

/** Map a Paystack subscription status to our enum. Pure. Returns null for an
 *  unrecognised status so the sync leaves the membership UNCHANGED rather than
 *  fail-open to 'active' (which would keep a cancelled member alive). */
export function mapPaystackStatus(status: string | undefined): MembershipStatus | null {
  switch (String(status ?? '').toLowerCase()) {
    case 'active':
    // 'non-renewing' = won't auto-renew, but still ACTIVE until the paid period
    // ends (Paystack then reports 'completed'). Keep access until then; don't
    // prematurely flip a paid-up member to cancelled.
    case 'non-renewing':
      return 'active';
    case 'attention':
      return 'past_due';
    case 'cancelled':
    case 'canceled':
    case 'completed':
      return 'cancelled';
    default:
      return null; // unknown — don't guess
  }
}
