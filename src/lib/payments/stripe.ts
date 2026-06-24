/**
 * Stripe payment links via Checkout Sessions, using the CLINIC's own Stripe
 * secret key (not Remi's). Payment is confirmed by retrieving the session on
 * return — no webhook plumbing needed.
 */
export async function createStripeCheckout(secretKey: string, o: {
  amountZar: number; currency?: string; name: string; invoiceId: string;
  successUrl: string; cancelUrl: string;
}): Promise<{ url: string; id: string }> {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', o.successUrl);
  form.set('cancel_url', o.cancelUrl);
  form.set('client_reference_id', o.invoiceId);
  form.set('metadata[invoice_id]', o.invoiceId);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', (o.currency || 'zar').toLowerCase());
  form.set('line_items[0][price_data][unit_amount]', String(Math.round(o.amountZar * 100)));
  form.set('line_items[0][price_data][product_data][name]', o.name);
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  return { url: data.url, id: data.id };
}

/** Returns true if the checkout session is paid. */
export async function retrieveStripeSession(secretKey: string, sessionId: string): Promise<{ paid: boolean }> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  return { paid: data.payment_status === 'paid' };
}
