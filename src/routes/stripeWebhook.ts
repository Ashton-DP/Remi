import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { constructWebhookEvent } from '../lib/stripe';
import { provisionFromCheckout } from '../lib/provisionClinic';
import { onTrialWillEnd, onPaymentFailed, onInvoicePaid } from '../lib/billingNotifications';
import { setClinicSubscriptionStatus } from '../db';

/**
 * POST /webhooks/stripe — tracks Remi's OWN subscription billing (clinics paying
 * you via your Stripe).
 *
 * - checkout.session.completed → a NEW clinic just subscribed from the website:
 *   provision the clinic record (with the right dashboard tier), create their
 *   login, and email it. Idempotent (Stripe retries webhooks).
 * - customer.subscription.* → keep that clinic's subscription_status in sync.
 *   These map to a clinic via the subscription's `clinic_id` metadata, which the
 *   checkout handler stamps on at provision time.
 *
 * Requires the RAW request body (mounted with express.raw in index.ts) for
 * signature verification.
 */
export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.header('stripe-signature') ?? '';
  let event;
  try {
    event = constructWebhookEvent(req.body as Buffer, sig);
  } catch (e: any) {
    console.error('[stripe] webhook signature failed:', e?.message);
    return res.status(400).send('bad signature');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    // Only provision for subscription checkouts that are actually paid/trialing.
    if (session.mode === 'subscription' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')) {
      try {
        const result = await provisionFromCheckout(session);
        console.log(`[stripe] checkout completed: ${result}`);
      } catch (e: any) {
        console.error('[stripe] provisioning failed:', e?.message ?? e);
        // 500 so Stripe retries — provisioning is important enough to retry.
        return res.status(500).json({ error: 'provisioning failed' });
      }
    }
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.paused' ||
    event.type === 'customer.subscription.resumed' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object as any;
    const clinicId = sub.metadata?.clinic_id;
    // 'deleted' = canceled. For paused/resumed/updated, sub.status already
    // reflects the new state ('paused' / 'active' / 'trialing'), so trust it.
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
    if (clinicId) {
      try {
        await setClinicSubscriptionStatus(clinicId, status);
        console.log(`[stripe] clinic ${clinicId} subscription → ${status}`);
      } catch (e) {
        console.error('[stripe] handler error', e);
      }
    } else {
      console.log('[stripe] subscription event without clinic_id metadata — skipped');
    }
  }

  // Trial about to end (~3 days out) — nudge the clinic to convert.
  if (event.type === 'customer.subscription.trial_will_end') {
    try { await onTrialWillEnd(event.data.object as Stripe.Subscription); }
    catch (e: any) { console.error('[stripe] trial_will_end error', e?.message ?? e); }
  }

  // Renewal card declined — flag past_due + email to update the card.
  if (event.type === 'invoice.payment_failed') {
    try { await onPaymentFailed(event.data.object as Stripe.Invoice); }
    catch (e: any) { console.error('[stripe] payment_failed error', e?.message ?? e); }
  }

  // Renewal succeeded — re-assert live status (recovers a past_due clinic) + log.
  if (event.type === 'invoice.paid') {
    try { await onInvoicePaid(event.data.object as Stripe.Invoice); }
    catch (e: any) { console.error('[stripe] invoice.paid error', e?.message ?? e); }
  }

  res.json({ received: true });
}
