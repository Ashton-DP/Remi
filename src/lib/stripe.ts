import Stripe from 'stripe';
import { config } from '../config';

const enabled = Boolean(config.stripe.secretKey);
const stripe = enabled ? new Stripe(config.stripe.secretKey) : null;

export const stripeEnabled = enabled;

/**
 * Create a one-off Stripe Checkout session for a booking deposit (ZAR).
 * Returns the payment URL, or null if Stripe isn't configured.
 */
export async function createDepositCheckout(opts: {
  amountZar: number;
  bookingId: string;
  clinicName: string;
  service: string;
}): Promise<string | null> {
  if (!stripe || !opts.amountZar) return null;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: config.stripe.successUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'zar',
          unit_amount: Math.round(opts.amountZar * 100), // cents
          product_data: { name: `${opts.clinicName} — ${opts.service} deposit` },
        },
      },
    ],
    metadata: { booking_id: opts.bookingId },
    payment_intent_data: { metadata: { booking_id: opts.bookingId } },
  });
  return session.url ?? null;
}

/** Verify + parse a Stripe webhook event from the raw request body. */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
