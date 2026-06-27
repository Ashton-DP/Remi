/**
 * Payment-provider registry. Each clinic brings its OWN provider + credentials
 * (PayFast / Paystack / a static hosted pay link) so customers can pay an
 * overdue invoice in one tap from the chase message. Remi only generates the
 * link and records the result — it never touches card data or moves money.
 */
import { config } from '../../config';
import { verifyStripeKey } from './stripe';
import { verifyPaystackKey } from './paystack';
import { verifyPaypalCreds } from './paypal';
import { verifyPayfastCreds } from './payfastSubscriptions';

export type PaymentProviderKey = 'payfast' | 'paystack' | 'stripe' | 'paypal' | 'link';

/**
 * Validate a clinic's payment credentials against the provider BEFORE saving, so
 * a clinic can't go "live" with a typo'd/wrong-mode key and silently break every
 * checkout. Throws a user-facing message on failure. Also enforces a PayFast
 * passphrase (without one, ITNs can be forged).
 */
export async function verifyPaymentCredentials(provider: PaymentProviderKey, cfg: any): Promise<void> {
  switch (provider) {
    case 'stripe':
      if (!cfg?.secret_key) throw new Error('Stripe secret key is required.');
      return verifyStripeKey(cfg.secret_key);
    case 'paystack':
      if (!cfg?.secret_key) throw new Error('Paystack secret key is required.');
      return verifyPaystackKey(cfg.secret_key);
    case 'paypal':
      if (!cfg?.client_id || !cfg?.secret) throw new Error('PayPal client ID and secret are required.');
      return verifyPaypalCreds({ client_id: cfg.client_id, secret: cfg.secret });
    case 'payfast':
      if (!cfg?.merchant_id || !cfg?.merchant_key) throw new Error('PayFast merchant ID and key are required.');
      if (!cfg?.passphrase) throw new Error('PayFast needs a passphrase — set one in your PayFast dashboard (Settings → Security passphrase) and enter it here. Without it, payment notifications can be forged.');
      return verifyPayfastCreds({ merchant_id: cfg.merchant_id, passphrase: cfg.passphrase });
    case 'link':
      if (!/^https:\/\//i.test(cfg?.url || '')) throw new Error('Enter a valid https:// payment link.');
      return;
    default:
      throw new Error('Unknown payment provider.');
  }
}

/** Which payment provider (if any) is fully configured for this clinic. */
export function getPaymentProvider(clinic: any): PaymentProviderKey | null {
  const p = clinic?.payment_provider;
  const cfg = clinic?.payment_config ?? {};
  if (p === 'payfast' && cfg.payfast?.merchant_id && cfg.payfast?.merchant_key) return 'payfast';
  if (p === 'paystack' && cfg.paystack?.secret_key) return 'paystack';
  if (p === 'stripe' && cfg.stripe?.secret_key) return 'stripe';
  if (p === 'paypal' && cfg.paypal?.client_id && cfg.paypal?.secret) return 'paypal';
  if (p === 'link' && cfg.link?.url) return 'link';
  return null;
}

/** The short, brandable pay link embedded in chase messages (UUID = unguessable). */
export function payUrlForInvoice(invoiceId: string): string {
  return `${config.payments.publicBase}/pay/${invoiceId}`;
}
