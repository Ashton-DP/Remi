import type { Request, Response } from 'express';
import { constructWebhookEvent } from '../lib/stripe';
import { setClinicSubscriptionStatus } from '../db';

/**
 * POST /webhooks/stripe — tracks Remi's OWN subscription billing (clinics paying
 * you via your Stripe). When a clinic subscribes/cancels, we update that clinic's
 * subscription_status. Map to a clinic by putting `clinic_id` in the subscription
 * metadata (set it on the Stripe Payment Link / Checkout).
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
