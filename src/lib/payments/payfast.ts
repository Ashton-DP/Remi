/**
 * PayFast payment-link generation + ITN (notify) validation. Per-clinic
 * credentials (the clinic's own PayFast merchant account) live on the clinic.
 * The signature build + validate are pure → unit-tested.
 */
import crypto from 'node:crypto';
import { config } from '../../config';

export function payfastProcessUrl(): string {
  return config.payments.payfastSandbox
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';
}

/** PayFast signature = md5 of url-encoded key=value pairs (+ optional passphrase).
 *  PayFast signs PHP-style (urlencode), where a SPACE is '+', not '%20' — values
 *  like item_name ("Invoice INV-1") and names contain spaces, so we must match
 *  that or PayFast rejects the signature. Verified against the live sandbox. Pure. */
export function buildPayfastSignature(params: Record<string, any>, passphrase?: string): string {
  const enc = (v: any) => encodeURIComponent(String(v ?? '').trim()).replace(/%20/g, '+');
  const str = Object.entries(params)
    .filter(([k]) => k !== 'signature')
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join('&');
  const withPass = passphrase ? `${str}&passphrase=${enc(passphrase)}` : str;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

/** Build the signed PayFast form params for one invoice. Pure. */
export function buildPayfastParams(
  invoice: { id: string; invoice_number?: string; contact_name?: string; contact_email?: string; amount_due: number },
  creds: { merchant_id?: string; merchant_key?: string; passphrase?: string },
  base: string,
): Record<string, string> {
  const nameParts = String(invoice.contact_name || 'Customer').split(' ');
  const params: Record<string, string> = {
    merchant_id: creds.merchant_id || '',
    merchant_key: creds.merchant_key || '',
    return_url: `${base}/pay/success`,
    cancel_url: `${base}/pay/cancel`,
    notify_url: `${base}/webhooks/payfast`,
    name_first: nameParts[0] || 'Customer',
    name_last: nameParts.slice(1).join(' ') || '',
    email_address: invoice.contact_email || '',
    m_payment_id: invoice.id,
    amount: Number(invoice.amount_due).toFixed(2),
    item_name: `Invoice ${invoice.invoice_number || invoice.id}`.slice(0, 100),
  };
  params.signature = buildPayfastSignature(params, creds.passphrase);
  return params;
}

/** Validate a PayFast ITN POST body against the clinic's passphrase. Pure. */
export function validatePayfastNotify(body: Record<string, any>, passphrase?: string): boolean {
  const { signature, ...rest } = body;
  if (!signature) return false;
  const expected = buildPayfastSignature(rest, passphrase);
  if (String(signature).length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(expected));
  } catch {
    return false;
  }
}
