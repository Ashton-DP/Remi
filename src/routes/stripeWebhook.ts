import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { constructWebhookEvent } from '../lib/stripe';
import { provisionFromCheckout } from '../lib/provisionClinic';
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
    event.type === 'customer.subscription.deleted'
  ) {
    const sub = event.data.object as any;
    const clinicId = sub.metadata?.clinic_id;
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

  res.json({ received: true });
}
