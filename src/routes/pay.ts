import type { Request, Response } from 'express';
import { config } from '../config';
import { qp } from '../lib/dashboardAuth';
import { getInvoiceById, getClinic, markInvoicePaidById, getMembershipById, activateMembership, setMembershipStatus } from '../db';
import { getPaymentProvider } from '../lib/payments';
import { payfastProcessUrl, buildPayfastParams, validatePayfastNotify, confirmPayfastNotify } from '../lib/payments/payfast';
import { isMembershipPaymentId, membershipIdFromPaymentId } from '../lib/payments/payfastSubscriptions';
import { initPaystackPayment, verifyPaystackTransaction } from '../lib/payments/paystack';
import { createStripeCheckout, retrieveStripeSession } from '../lib/payments/stripe';
import { createPaypalOrder, capturePaypalOrder } from '../lib/payments/paypal';

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const note = (title: string, body: string) =>
  `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;text-align:center;color:#1e2233">
   <h2>${title}</h2><p style="color:#64748b">${body}</p></body>`;

/** GET /pay/:invoiceId — route the payer to their clinic's payment provider. */
export async function handlePay(req: Request, res: Response) {
  const invoiceId = qp(req.params.invoiceId) ?? '';
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) return res.status(404).type('text/html').send(note('Not found', 'This payment link is invalid or has expired.'));
  if (invoice.status === 'paid') return res.type('text/html').send(note('Already paid ✅', 'This invoice has been settled. Thank you!'));

  const clinic = await getClinic(invoice.clinic_id);
  const provider = getPaymentProvider(clinic);
  if (!provider) return res.status(503).type('text/html').send(note('Payment not set up', 'This business has not enabled online payment yet.'));

  try {
    if (provider === 'payfast') {
      const params = buildPayfastParams(invoice, clinic.payment_config.payfast, config.payments.publicBase);
      const fields = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      return res.type('text/html').send(
        `<!DOCTYPE html><meta charset="utf-8"><body onload="document.forms[0].submit()" style="font-family:sans-serif;text-align:center;margin-top:80px;color:#64748b">
         <p>Redirecting to secure payment…</p>
         <form action="${payfastProcessUrl()}" method="post">${fields}<noscript><button type="submit">Continue to payment</button></noscript></form></body>`);
    }
    if (provider === 'paystack') {
      const out = await initPaystackPayment(clinic.payment_config.paystack.secret_key, {
        email: invoice.contact_email || 'customer@example.com',
        amountZar: Number(invoice.amount_due),
        reference: `remi_${invoice.id}`,
        metadata: { invoice_id: invoice.id, clinic_id: invoice.clinic_id },
        // Route back through a handler that verifies the txn + marks the invoice
        // paid — /pay/success alone is a static page that never settles it.
        callbackUrl: `${config.payments.publicBase}/pay/paystack/return?inv=${invoice.id}`,
      });
      return res.redirect(out.authorization_url);
    }
    if (provider === 'stripe') {
      const base = config.payments.publicBase;
      const out = await createStripeCheckout(clinic.payment_config.stripe.secret_key, {
        amountZar: Number(invoice.amount_due), currency: invoice.currency,
        name: `Invoice ${invoice.invoice_number || invoice.id}`, invoiceId: invoice.id,
        successUrl: `${base}/pay/stripe/return?inv=${invoice.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/pay/cancel`,
      });
      return res.redirect(out.url);
    }
    if (provider === 'paypal') {
      const base = config.payments.publicBase;
      const out = await createPaypalOrder(clinic.payment_config.paypal, {
        amount: Number(invoice.amount_due), currency: invoice.currency, invoiceId: invoice.id,
        itemName: `Invoice ${invoice.invoice_number || invoice.id}`,
        returnUrl: `${base}/pay/paypal/return?inv=${invoice.id}`,
        cancelUrl: `${base}/pay/cancel`,
      });
      return res.redirect(out.approveUrl);
    }
    // static link
    return res.redirect(clinic.payment_config.link.url);
  } catch (e: any) {
    console.error('[pay]', e?.message ?? e);
    return res.status(502).type('text/html').send(note('Payment error', 'Could not start the payment. Please try again shortly.'));
  }
}

export function handlePaySuccess(_req: Request, res: Response) {
  res.type('text/html').send(note('Thank you! 💛', 'Your payment is being processed. You can close this page.'));
}
export function handlePayCancel(_req: Request, res: Response) {
  res.type('text/html').send(note('Payment cancelled', 'No payment was taken. You can use the link again any time.'));
}

/** GET /pay/stripe/return?inv=&session_id= — confirm a Stripe payment + mark paid. */
export async function handleStripeReturn(req: Request, res: Response) {
  try {
    const invoiceId = qp(req.query.inv) ?? '';
    const sessionId = qp(req.query.session_id) ?? '';
    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) return res.type('text/html').send(note('Thank you', 'Payment received.'));
    const clinic = await getClinic(invoice.clinic_id);
    const { paid } = await retrieveStripeSession(clinic.payment_config.stripe.secret_key, sessionId);
    if (paid) { await markInvoicePaidById(invoiceId); return res.type('text/html').send(note('Paid ✅', 'Thank you! Your payment was successful.')); }
    return res.type('text/html').send(note('Thank you 💛', 'Your payment is being processed.'));
  } catch (e: any) {
    console.error('[pay/stripe]', e?.message ?? e);
    return res.type('text/html').send(note('Thank you 💛', 'Your payment is being processed.'));
  }
}

/** GET /pay/paystack/return?inv=&reference= — verify the txn + mark the invoice paid. */
export async function handlePaystackReturn(req: Request, res: Response) {
  try {
    const invoiceId = qp(req.query.inv) ?? '';
    const reference = qp(req.query.reference) ?? qp(req.query.trxref) ?? `remi_${invoiceId}`;
    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) return res.type('text/html').send(note('Thank you', 'Payment received.'));
    const clinic = await getClinic(invoice.clinic_id);
    const { paid } = await verifyPaystackTransaction(clinic.payment_config.paystack.secret_key, reference);
    if (paid) { await markInvoicePaidById(invoiceId); return res.type('text/html').send(note('Paid ✅', 'Thank you! Your payment was successful.')); }
    return res.type('text/html').send(note('Thank you 💛', 'Your payment is being processed.'));
  } catch (e: any) {
    console.error('[pay/paystack]', e?.message ?? e);
    return res.type('text/html').send(note('Thank you 💛', 'Your payment is being processed.'));
  }
}

/** GET /pay/paypal/return?inv=&token= — capture an approved PayPal order + mark paid. */
export async function handlePaypalReturn(req: Request, res: Response) {
  try {
    const invoiceId = qp(req.query.inv) ?? '';
    const orderId = qp(req.query.token) ?? ''; // PayPal appends ?token=<orderId>
    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) return res.type('text/html').send(note('Thank you', 'Payment received.'));
    const clinic = await getClinic(invoice.clinic_id);
    const { completed } = await capturePaypalOrder(clinic.payment_config.paypal, orderId);
    if (completed) { await markInvoicePaidById(invoiceId); return res.type('text/html').send(note('Paid ✅', 'Thank you! Your payment was successful.')); }
    return res.type('text/html').send(note('Thank you 💛', 'Your payment is being processed.'));
  } catch (e: any) {
    console.error('[pay/paypal]', e?.message ?? e);
    return res.type('text/html').send(note('Thank you 💛', 'Your payment is being processed.'));
  }
}

/** POST /webhooks/payfast — PayFast ITN. Marks the invoice paid on COMPLETE. */
export async function handlePayfastNotify(req: Request, res: Response) {
  res.status(200).end(); // acknowledge immediately; PayFast doesn't read a body
  try {
    const body = req.body || {};
    const mPaymentId = body.m_payment_id;
    if (!mPaymentId) return;

    // Membership subscription ITNs carry a `mem_` prefix + a subscription token.
    if (isMembershipPaymentId(mPaymentId)) {
      const membershipId = membershipIdFromPaymentId(mPaymentId);
      const membership = await getMembershipById(membershipId);
      if (!membership) return;
      const clinic = await getClinic(membership.clinic_id);
      const passphrase = clinic?.payment_config?.payfast?.passphrase;
      // Without a passphrase the signature is forgeable — refuse to act on the ITN.
      if (!passphrase) { console.warn('[payfast] no passphrase set — rejecting membership ITN', membershipId); return; }
      if (!validatePayfastNotify(body, passphrase)) { console.warn('[payfast] bad signature for membership', membershipId); return; }
      // Defence-in-depth: confirm the ITN really came from PayFast (server postback).
      if (!(await confirmPayfastNotify(body))) { console.warn('[payfast] postback NOT VALID for membership', membershipId); return; }
      const token = body.token || body.subscription_token;
      if (body.payment_status === 'COMPLETE' && token) {
        // Verify the amount actually charged matches the plan price — the PayFast
        // form is client-submitted, so without this a caller could tamper the amount
        // down and still activate a full membership off a valid-signature ITN.
        const paid = Number(body.amount_gross);
        const expected = Number(membership.amount_zar);
        if (Number.isFinite(paid) && Number.isFinite(expected) && Math.abs(paid - expected) > 0.01) {
          console.warn(`[payfast] membership ${membershipId} amount mismatch: paid ${paid} vs ${expected} — NOT activating`);
          return;
        }
        // First payment activates; each recurring payment refreshes the renewal date.
        if (membership.status !== 'active' || !membership.external_subscription_id) {
          await activateMembership(membership.id, token, body.billing_date || null);
          console.log(`[payfast] membership ${membershipId} activated`);
        } else if (body.billing_date) {
          await setMembershipStatus(membership.id, 'active', body.billing_date);
        }
      } else if (body.payment_status === 'CANCELLED') {
        await setMembershipStatus(membership.id, 'cancelled');
        console.log(`[payfast] membership ${membershipId} cancelled via ITN`);
      } else if (body.payment_status === 'FAILED') {
        // A recurring collection failed — flag past_due so the member shows as
        // needing attention (the daily sync / next ITN can restore active).
        if (membership.status === 'active') {
          await setMembershipStatus(membership.id, 'past_due');
          console.log(`[payfast] membership ${membershipId} → past_due (recurring charge failed)`);
        }
      }
      return;
    }

    const invoiceId = mPaymentId;
    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) return;
    const clinic = await getClinic(invoice.clinic_id);
    const passphrase = clinic?.payment_config?.payfast?.passphrase;
    if (!passphrase) { console.warn('[payfast] no passphrase set — rejecting invoice ITN', invoiceId); return; }
    if (!validatePayfastNotify(body, passphrase)) { console.warn('[payfast] bad signature for', invoiceId); return; }
    if (!(await confirmPayfastNotify(body))) { console.warn('[payfast] postback NOT VALID for invoice', invoiceId); return; }
    if (body.payment_status === 'COMPLETE') {
      // Verify the amount actually paid matches what's owed — don't mark a R5000
      // invoice "paid" off an R5 ITN.
      const paid = Number(body.amount_gross);
      const due = Number(invoice.amount_due);
      if (Number.isFinite(paid) && Number.isFinite(due) && Math.abs(paid - due) > 0.01) {
        console.warn(`[payfast] amount mismatch for ${invoiceId}: paid ${paid} vs due ${due} — NOT marking paid`);
        return;
      }
      await markInvoicePaidById(invoiceId);
      console.log(`[payfast] invoice ${invoice.invoice_number} marked paid`);
    }
  } catch (e: any) {
    console.error('[payfast] notify error:', e?.message ?? e);
  }
}
