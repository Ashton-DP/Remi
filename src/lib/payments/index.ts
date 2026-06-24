/**
 * Payment-provider registry. Each clinic brings its OWN provider + credentials
 * (PayFast / Paystack / a static hosted pay link) so customers can pay an
 * overdue invoice in one tap from the chase message. Remi only generates the
 * link and records the result — it never touches card data or moves money.
 */
import { config } from '../../config';

export type PaymentProviderKey = 'payfast' | 'paystack' | 'link';

/** Which payment provider (if any) is fully configured for this clinic. */
export function getPaymentProvider(clinic: any): PaymentProviderKey | null {
  const p = clinic?.payment_provider;
  const cfg = clinic?.payment_config ?? {};
  if (p === 'payfast' && cfg.payfast?.merchant_id && cfg.payfast?.merchant_key) return 'payfast';
  if (p === 'paystack' && cfg.paystack?.secret_key) return 'paystack';
  if (p === 'link' && cfg.link?.url) return 'link';
  return null;
}

/** The short, brandable pay link embedded in chase messages (UUID = unguessable). */
export function payUrlForInvoice(invoiceId: string): string {
  return `${config.payments.publicBase}/pay/${invoiceId}`;
}
