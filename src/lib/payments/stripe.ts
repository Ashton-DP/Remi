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

/**
 * Recurring membership signup via Checkout in `subscription` mode, using the
 * CLINIC's own Stripe key (money goes to the clinic). Price is created inline
 * with price_data so the clinic doesn't need to pre-create Products/Prices.
 */
export async function createStripeSubscriptionCheckout(secretKey: string, o: {
  amountZar: number; currency?: string; planName: string; interval: 'month' | 'year';
  membershipId: string; successUrl: string; cancelUrl: string; customerEmail?: string;
}): Promise<{ url: string; id: string }> {
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('success_url', o.successUrl);
  form.set('cancel_url', o.cancelUrl);
  form.set('client_reference_id', o.membershipId);
  form.set('metadata[membership_id]', o.membershipId);
  // Stamp metadata on the subscription too, so a webhook/sync can map back to us.
  form.set('subscription_data[metadata][membership_id]', o.membershipId);
  if (o.customerEmail) form.set('customer_email', o.customerEmail);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', (o.currency || 'zar').toLowerCase());
  form.set('line_items[0][price_data][unit_amount]', String(Math.round(o.amountZar * 100)));
  form.set('line_items[0][price_data][recurring][interval]', o.interval);
  form.set('line_items[0][price_data][product_data][name]', o.planName);
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  return { url: data.url, id: data.id };
}

/** Read a Checkout session and return the subscription id it created (if any). */
export async function retrieveStripeSubscriptionFromSession(
  secretKey: string, sessionId: string,
): Promise<{ subscriptionId: string | null; active: boolean }> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  const subscriptionId = typeof data.subscription === 'string' ? data.subscription : data.subscription?.id ?? null;
  // 'paid' for the first invoice, or 'no_payment_required' for a trial.
  const active = data.payment_status === 'paid' || data.payment_status === 'no_payment_required';
  return { subscriptionId, active };
}

/** Current status + next renewal of a subscription (for the periodic sync job). */
export async function retrieveStripeSubscription(
  secretKey: string, subscriptionId: string,
): Promise<{ status: string; currentPeriodEnd: string | null }> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  // current_period_end sits on the subscription in older API versions and on the
  // subscription item in newer ones — read whichever is present.
  const epoch = typeof data.current_period_end === 'number'
    ? data.current_period_end
    : data.items?.data?.[0]?.current_period_end ?? null;
  const cpe = typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
  return { status: data.status, currentPeriodEnd: cpe };
}

/** Cancel a subscription at period end (clinic's own Stripe). */
export async function cancelStripeSubscription(secretKey: string, subscriptionId: string): Promise<void> {
  const form = new URLSearchParams();
  form.set('cancel_at_period_end', 'true');
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Stripe ${res.status}`);
  }
}
