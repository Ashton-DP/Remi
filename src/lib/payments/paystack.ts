/**
 * Paystack payment-link initialisation + webhook verification (ZAR).
 * Per-clinic secret key (the clinic's own Paystack account).
 */
import crypto from 'node:crypto';

/** Initialise a one-off transaction; returns { authorization_url, reference }. */
export async function initPaystackPayment(secretKey: string, o: {
  email: string; amountZar: number; reference: string; metadata?: any; callbackUrl?: string;
}): Promise<{ authorization_url: string; reference: string }> {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: o.email,
      amount: Math.round(o.amountZar * 100), // minor units (cents)
      reference: o.reference,
      metadata: o.metadata,
      callback_url: o.callbackUrl,
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) throw new Error(data.message || `Paystack ${res.status}`);
  return data.data;
}

/** Verify a transaction by reference (server-side). Returns whether it's paid. */
export async function verifyPaystackTransaction(secretKey: string, reference: string): Promise<{ paid: boolean }> {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === false) throw new Error(data?.message || `Paystack ${res.status}`);
  return { paid: data?.data?.status === 'success' };
}

/** Webhook signature = HMAC SHA512 of the raw body, keyed by the secret key. Pure. */
export function verifyPaystackWebhook(rawBody: string, signature: string, secretKey: string): boolean {
  if (!secretKey || !signature) return false;
  const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(hash);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
