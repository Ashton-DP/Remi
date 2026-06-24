import type { Request, Response } from 'express';
import { config } from '../config';
import { qp } from '../lib/dashboardAuth';
import { getInvoiceById, getClinic, markInvoicePaidById } from '../db';
import { getPaymentProvider } from '../lib/payments';
import { payfastProcessUrl, buildPayfastParams, validatePayfastNotify } from '../lib/payments/payfast';
import { initPaystackPayment } from '../lib/payments/paystack';

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
        callbackUrl: `${config.payments.publicBase}/pay/success`,
      });
      return res.redirect(out.authorization_url);
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

/** POST /webhooks/payfast — PayFast ITN. Marks the invoice paid on COMPLETE. */
export async function handlePayfastNotify(req: Request, res: Response) {
  res.status(200).end(); // acknowledge immediately; PayFast doesn't read a body
  try {
    const body = req.body || {};
    const invoiceId = body.m_payment_id;
    if (!invoiceId) return;
    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) return;
    const clinic = await getClinic(invoice.clinic_id);
    const passphrase = clinic?.payment_config?.payfast?.passphrase;
    if (!validatePayfastNotify(body, passphrase)) { console.warn('[payfast] bad signature for', invoiceId); return; }
    if (body.payment_status === 'COMPLETE') {
      await markInvoicePaidById(invoiceId);
      console.log(`[payfast] invoice ${invoice.invoice_number} marked paid`);
    }
  } catch (e: any) {
    console.error('[payfast] notify error:', e?.message ?? e);
  }
}
