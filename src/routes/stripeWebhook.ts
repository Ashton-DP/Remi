import type { Request, Response } from 'express';
import { constructWebhookEvent } from '../lib/stripe';
import { setBookingDepositStatus, logEvent } from '../db';
import { supabase } from '../lib/supabase';

/**
 * POST /webhooks/stripe — marks a booking's deposit paid when Stripe Checkout
 * completes. Requires the RAW request body (mounted with express.raw in index.ts)
 * for signature verification.
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
    const session = event.data.object as any;
    const bookingId = session.metadata?.booking_id;
    if (bookingId) {
      try {
        await setBookingDepositStatus(bookingId, 'paid');
        const { data: b } = await supabase.from('bookings').select('clinic_id').eq('id', bookingId).maybeSingle();
        if (b?.clinic_id) {
          await logEvent(b.clinic_id, 'deposit_paid', Math.round((session.amount_total ?? 0) / 100), bookingId);
        }
        console.log('[stripe] deposit paid for booking', bookingId);
      } catch (e) {
        console.error('[stripe] handler error', e);
      }
    }
  }

  res.json({ received: true });
}
