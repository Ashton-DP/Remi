/**
 * Public membership signup flow. Mirrors the invoice-pay pattern: the dashboard
 * creates a `pending` membership row (UUID = unguessable link), the client opens
 * /membership/:id/start, pays via the clinic's OWN recurring provider, and the
 * row is activated. Stripe/Paystack confirm on the return URL; PayFast confirms
 * via its ITN to /webhooks/payfast. Renewals are reconciled by the daily sync.
 */
import type { Request, Response } from 'express';
import { qp } from '../lib/dashboardAuth';
import { getMembershipById, getClinic, activateMembership, setMembershipCheckoutRef } from '../db';
import { membershipProvider, startMembershipCheckout, confirmMembershipReturn } from '../lib/subscriptions';

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const note = (title: string, body: string) =>
  `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;text-align:center;color:#1e2233">
   <h2>${title}</h2><p style="color:#64748b">${body}</p></body>`;

/** GET /membership/:id/start — kick off the subscription checkout for this client. */
export async function handleMembershipStart(req: Request, res: Response) {
  const id = qp(req.params.id) ?? '';
  const membership = await getMembershipById(id);
  if (!membership) return res.status(404).type('text/html').send(note('Not found', 'This membership link is invalid or has expired.'));
  if (membership.status === 'active') return res.type('text/html').send(note('Already active ✅', "You're already a member — nothing more to do!"));

  const clinic = await getClinic(membership.clinic_id);
  if (!membership.provider || membershipProvider(clinic) !== membership.provider) {
    return res.status(503).type('text/html').send(note('Not available', 'This business has not enabled membership billing yet.'));
  }
  if (!(Number(membership.amount_zar) > 0)) {
    return res.status(400).type('text/html').send(note('Setup incomplete', 'This membership has no price set. Please contact the clinic.'));
  }

  try {
    const start = await startMembershipCheckout(clinic, membership);
    // Persist the checkout ref so the daily job can reconcile this payment even
    // if the client never makes it back to the confirm URL.
    if (start.checkoutRef) await setMembershipCheckoutRef(membership.clinic_id, membership.id, start.checkoutRef).catch(() => {});
    if (start.kind === 'redirect') return res.redirect(start.url);
    // PayFast: auto-submit the signed subscription form.
    const fields = Object.entries(start.fields)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    return res.type('text/html').send(
      `<!DOCTYPE html><meta charset="utf-8"><body onload="document.forms[0].submit()" style="font-family:sans-serif;text-align:center;margin-top:80px;color:#64748b">
       <p>Redirecting to secure signup…</p>
       <form action="${esc(start.actionUrl)}" method="post">${fields}<noscript><button type="submit">Continue</button></noscript></form></body>`);
  } catch (e: any) {
    console.error('[membership/start]', e?.message ?? e);
    return res.status(502).type('text/html').send(note('Could not start', 'We could not start the membership. Please try again shortly.'));
  }
}

/** GET /membership/:id/return — confirm the subscription + activate (Stripe/Paystack). */
export async function handleMembershipReturn(req: Request, res: Response) {
  try {
    const id = qp(req.params.id) ?? '';
    const membership = await getMembershipById(id);
    if (!membership) return res.type('text/html').send(note('Thank you 💛', 'Your membership is being set up.'));
    const clinic = await getClinic(membership.clinic_id);

    const confirmed = await confirmMembershipReturn(clinic, membership, req.query as Record<string, any>);
    if (confirmed) {
      await activateMembership(membership.clinic_id, membership.id, confirmed.externalId, confirmed.renewsAt);
      return res.type('text/html').send(note("You're a member! 🎉", `Welcome to ${esc(clinic.name)}'s ${esc(membership.plan_name)}. Your subscription is active.`));
    }
    // PayFast (ITN-confirmed) or still-processing — reassure, the webhook/sync finishes it.
    return res.type('text/html').send(note('Thank you 💛', 'Your membership is being set up — you’ll get confirmation shortly.'));
  } catch (e: any) {
    console.error('[membership/return]', e?.message ?? e);
    return res.type('text/html').send(note('Thank you 💛', 'Your membership is being set up.'));
  }
}
