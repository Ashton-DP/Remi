/**
 * Membership (recurring-billing) coordinator. The dashboard, signup route and
 * scheduler all go through here and never touch a specific provider directly.
 *
 * Three providers are supported, each charging on the clinic's OWN account:
 *   - stripe   — Checkout (subscription mode); confirms on return.
 *   - payfast  — subscription form; confirms via ITN (not the return URL).
 *   - paystack — Plan + transaction; confirms on return.
 */
import { config } from '../config';
import { getPaymentProvider } from './payments';
import type { MembershipStatus } from './clientOs';
import { mapStripeSubStatus } from './clientOs';
import {
  createStripeSubscriptionCheckout, retrieveStripeSubscriptionFromSession,
  retrieveStripeSubscription, cancelStripeSubscription,
} from './payments/stripe';
import {
  buildPayfastSubscriptionParams, cancelPayfastSubscription, fetchPayfastSubscription,
} from './payments/payfastSubscriptions';
import { payfastProcessUrl } from './payments/payfast';
import {
  startPaystackSubscription, confirmPaystackSubscription, fetchPaystackSubscription,
  cancelPaystackSubscription,
} from './payments/paystackSubscriptions';

export type SubProvider = 'stripe' | 'payfast' | 'paystack';

export type StartResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'form'; actionUrl: string; fields: Record<string, string> };

/** Which recurring provider this clinic can use for memberships, if any. */
export function membershipProvider(clinic: any): SubProvider | null {
  const p = getPaymentProvider(clinic);
  return p === 'stripe' || p === 'payfast' || p === 'paystack' ? p : null;
}

/** Begin the signup checkout for a pending membership. `checkoutRef` (Stripe
 *  session id / Paystack reference) is returned so the caller can store it and the
 *  daily job can later reconcile a payment the client made but never returned to
 *  confirm. PayFast has no ref — its ITN activates regardless of the return. */
export async function startMembershipCheckout(
  clinic: any, membership: any,
): Promise<StartResult & { checkoutRef?: string }> {
  const base = config.payments.publicBase;
  const cfg = clinic.payment_config ?? {};
  const amount = Number(membership.amount_zar);
  const interval: 'month' | 'year' = membership.billing_interval === 'year' ? 'year' : 'month';
  const client = membership.clients ?? {};

  switch (membership.provider) {
    case 'stripe': {
      const out = await createStripeSubscriptionCheckout(cfg.stripe.secret_key, {
        amountZar: amount, interval, planName: membership.plan_name, membershipId: membership.id,
        customerEmail: client.email || undefined,
        successUrl: `${base}/membership/${membership.id}/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/pay/cancel`,
      });
      return { kind: 'redirect', url: out.url, checkoutRef: out.id };
    }
    case 'payfast': {
      const fields = buildPayfastSubscriptionParams(membership, client, cfg.payfast, base);
      return { kind: 'form', actionUrl: payfastProcessUrl(), fields };
    }
    case 'paystack': {
      // Unique reference per attempt (Paystack rejects duplicates). We don't need
      // to reconstruct it — Paystack appends ?reference= to the callback URL.
      const reference = `mem_${membership.id}_${Date.now()}`;
      const out = await startPaystackSubscription(cfg.paystack.secret_key, {
        email: client.email || 'customer@example.com',
        amountZar: amount, planName: membership.plan_name, interval,
        reference,
        callbackUrl: `${base}/membership/${membership.id}/return`,
      });
      return { kind: 'redirect', url: out.authorization_url, checkoutRef: reference };
    }
    default:
      throw new Error(`Unsupported membership provider: ${membership.provider}`);
  }
}

/** Reconcile a still-pending membership against the provider using the stored
 *  checkout ref — for clients who paid but never returned to the confirm URL.
 *  Returns activation details if the payment went through, else null. */
export async function reconcilePendingMembership(
  clinic: any, membership: any,
): Promise<{ externalId: string; renewsAt: string | null } | null> {
  const cfg = clinic.payment_config ?? {};
  const ref = membership.checkout_ref;
  if (!ref) return null;
  switch (membership.provider) {
    case 'stripe': {
      const { subscriptionId, active } = await retrieveStripeSubscriptionFromSession(cfg.stripe.secret_key, ref);
      if (!subscriptionId || !active) return null;
      let renewsAt: string | null = null;
      try { renewsAt = (await retrieveStripeSubscription(cfg.stripe.secret_key, subscriptionId)).currentPeriodEnd; } catch { /* best-effort */ }
      return { externalId: subscriptionId, renewsAt };
    }
    case 'paystack': {
      const out = await confirmPaystackSubscription(cfg.paystack.secret_key, ref);
      if (!out) return null;
      return { externalId: out.subscriptionCode, renewsAt: out.renewsAt };
    }
    case 'payfast':
      return null; // PayFast activates via ITN; a pending PayFast row means no payment landed.
    default:
      return null;
  }
}

/**
 * Confirm a subscription after the client returns from the provider.
 * Returns activation details, or null if not confirmable here (PayFast — its ITN
 * does the activation instead).
 */
export async function confirmMembershipReturn(
  clinic: any, membership: any, query: Record<string, any>,
): Promise<{ externalId: string; renewsAt: string | null } | null> {
  const cfg = clinic.payment_config ?? {};
  switch (membership.provider) {
    case 'stripe': {
      const sessionId = String(query.session_id ?? '');
      if (!sessionId) return null;
      const { subscriptionId, active } = await retrieveStripeSubscriptionFromSession(cfg.stripe.secret_key, sessionId);
      if (!subscriptionId || !active) return null;
      let renewsAt: string | null = null;
      try { renewsAt = (await retrieveStripeSubscription(cfg.stripe.secret_key, subscriptionId)).currentPeriodEnd; } catch { /* best-effort */ }
      return { externalId: subscriptionId, renewsAt };
    }
    case 'paystack': {
      // Paystack returns the transaction reference in the callback query.
      const reference = String(query.reference ?? query.trxref ?? '');
      if (!reference) return null;
      const out = await confirmPaystackSubscription(cfg.paystack.secret_key, reference);
      if (!out) return null;
      return { externalId: out.subscriptionCode, renewsAt: out.renewsAt };
    }
    case 'payfast':
      // PayFast confirms via ITN to /webhooks/payfast, not the return URL.
      return null;
    default:
      return null;
  }
}

/** Reconcile a membership's status + renewal date from the provider (daily sync). */
export async function syncMembershipStatus(
  clinic: any, membership: any,
): Promise<{ status: MembershipStatus | null; renewsAt: string | null } | null> {
  const cfg = clinic.payment_config ?? {};
  const extId = membership.external_subscription_id;
  if (!extId) return null;
  switch (membership.provider) {
    case 'stripe': {
      const sub = await retrieveStripeSubscription(cfg.stripe.secret_key, extId);
      return { status: mapStripeSubStatus(sub.status), renewsAt: sub.currentPeriodEnd };
    }
    case 'payfast':
      return fetchPayfastSubscription(cfg.payfast, extId);
    case 'paystack':
      return fetchPaystackSubscription(cfg.paystack.secret_key, extId);
    default:
      return null;
  }
}

/** Cancel the subscription at the provider (stops future billing). */
export async function cancelMembershipSubscription(clinic: any, membership: any): Promise<void> {
  const cfg = clinic.payment_config ?? {};
  const extId = membership.external_subscription_id;
  if (!extId) return; // nothing was ever set up at the provider
  switch (membership.provider) {
    case 'stripe':
      return cancelStripeSubscription(cfg.stripe.secret_key, extId);
    case 'payfast':
      return cancelPayfastSubscription(cfg.payfast, extId);
    case 'paystack':
      return cancelPaystackSubscription(cfg.paystack.secret_key, extId);
    default:
      return;
  }
}
