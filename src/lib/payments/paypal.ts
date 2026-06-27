/**
 * PayPal payment links via the Orders API v2, using the CLINIC's own PayPal app
 * credentials. Flow: create order → redirect to the approve link → capture on
 * return. (Note: PayPal's ZAR support for SA merchants is limited — best for
 * clinics invoicing in USD/EUR or with an international PayPal account.)
 */
import { config } from '../../config';

type PaypalCreds = { client_id: string; secret: string };
function apiBase(): string {
  return config.payments.paypalSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
}

async function accessToken(creds: PaypalCreds): Promise<string> {
  const auth = Buffer.from(`${creds.client_id}:${creds.secret}`).toString('base64');
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error_description || `PayPal token ${res.status}`);
  return data.access_token;
}

/** Verify PayPal app credentials by fetching an OAuth token (throws if invalid). */
export async function verifyPaypalCreds(creds: PaypalCreds): Promise<void> {
  await accessToken(creds);
}

export async function createPaypalOrder(creds: PaypalCreds, o: {
  amount: number; currency?: string; invoiceId: string; itemName: string; returnUrl: string; cancelUrl: string;
}): Promise<{ approveUrl: string; id: string }> {
  const at = await accessToken(creds);
  const res = await fetch(`${apiBase()}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: o.invoiceId,
        description: o.itemName.slice(0, 127),
        amount: { currency_code: (o.currency || 'ZAR').toUpperCase(), value: Number(o.amount).toFixed(2) },
      }],
      application_context: { return_url: o.returnUrl, cancel_url: o.cancelUrl, shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `PayPal order ${res.status}`);
  const approve = (data.links || []).find((l: any) => l.rel === 'approve')?.href;
  if (!approve) throw new Error('PayPal: no approve link returned');
  return { approveUrl: approve, id: data.id };
}

/** Capture an approved order on return; true if the payment completed. */
export async function capturePaypalOrder(creds: PaypalCreds, orderId: string): Promise<{ completed: boolean }> {
  const at = await accessToken(creds);
  const res = await fetch(`${apiBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `PayPal capture ${res.status}`);
  return { completed: data.status === 'COMPLETED' };
}
