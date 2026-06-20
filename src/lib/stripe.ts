import Stripe from 'stripe';
import { config } from '../config';

const enabled = Boolean(config.stripe.secretKey);
const stripe = enabled ? new Stripe(config.stripe.secretKey) : null;

export const stripeEnabled = enabled;

/**
 * Verify + parse a Stripe webhook event from the raw request body.
 * Used to track Remi's OWN subscription billing (clinics paying you via your
 * Stripe). Deposits are handled separately, per-clinic, provider-agnostic.
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
