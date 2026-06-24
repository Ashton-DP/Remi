/**
 * Invoice chase runner — the outbound loop (ported from PaidUp's chaser).
 *
 * For each clinic: walk its chaseable invoices, work out the due stage, and send
 * the chase over EVERY channel the contact is reachable on — WhatsApp/SMS (if a
 * phone) and email (if an address + email configured) — honouring the per-clinic
 * kill switch and the opt-out suppression list per channel. The stage advances
 * once if any channel sent; every send is logged.
 */
import { config } from '../config';
import {
  getClinic, getChaseableInvoices, advanceInvoiceChase, logInvoiceChase, isSuppressed,
} from '../db';
import { sendProactiveWhatsApp } from './twilio';
import { sendChaseEmail } from './email';
import { generateChaseMessage } from './chaseMessage';
import { getPaymentProvider, payUrlForInvoice } from './payments';
import { nextChaseStage, daysOverdue, phoneKey, emailKey, DEFAULT_CADENCE, type ChaseCadence } from './chase';

export async function runChaseForClinic(clinicId: string): Promise<number> {
  const clinic = await getClinic(clinicId);
  if (!clinic) return 0;
  if (clinic.chasing_paused) {
    console.log(`[chase] paused for ${clinic.name ?? clinicId} — skipping`);
    return 0;
  }

  const cadence: ChaseCadence = clinic.chase_cadence ?? DEFAULT_CADENCE;
  const senderName: string = clinic.name ?? 'our team';
  const phoneChannel = config.twilio.channel; // 'whatsapp' | 'sms'
  const hasPay = getPaymentProvider(clinic) !== null; // a "Pay now" link is available
  const invoices = await getChaseableInvoices(clinicId);
  let chased = 0;

  for (const inv of invoices as any[]) {
    const overdue = daysOverdue(inv.due_date);
    const stage = nextChaseStage(
      { days_overdue: overdue, chase_stage: inv.chase_stage ?? 0, last_chased_at: inv.last_chased_at, snoozed_until: inv.snoozed_until },
      cadence,
    );
    if (!stage) continue;

    const payUrl = hasPay ? payUrlForInvoice(inv.id) : null;
    const base = {
      contactName: inv.contact_name, invoiceNumber: inv.invoice_number, amount: inv.amount_due,
      currency: inv.currency, daysOverdue: overdue, dueDate: inv.due_date, stage, senderName,
      hasPayLink: hasPay,
    };
    let sentAny = false;

    // ── Phone (WhatsApp / SMS) ──────────────────────────────────────────────
    if (inv.contact_phone && !(await isSuppressed(clinicId, phoneChannel, phoneKey(inv.contact_phone)))) {
      try {
        const msg = await generateChaseMessage({ ...base, channel: phoneChannel });
        const body = payUrl ? `${msg}\n\nPay now: ${payUrl}` : msg;
        await sendProactiveWhatsApp(inv.contact_phone, { fallbackBody: body });
        await logInvoiceChase({ invoiceId: inv.id, clinicId, stage, channel: phoneChannel, recipient: inv.contact_phone, body });
        sentAny = true;
      } catch (err: any) {
        console.error(`[chase] ${phoneChannel} failed for ${inv.invoice_number}:`, err?.message ?? err);
      }
    }

    // ── Email ───────────────────────────────────────────────────────────────
    if (config.email.enabled && inv.contact_email && !(await isSuppressed(clinicId, 'email', emailKey(inv.contact_email)))) {
      try {
        const raw = await generateChaseMessage({ ...base, channel: 'email' });
        await sendChaseEmail({
          to: inv.contact_email, toName: inv.contact_name, rawMessage: raw,
          invoiceNumber: inv.invoice_number, senderName, paymentUrl: payUrl,
          // Send AS THE CLINIC. Use their own From address only once their domain
          // is VERIFIED in Resend (else it'd bounce/spam) — until then it's
          // send-on-behalf (clinic name on Remi's domain). Reply-To always routes
          // replies to the clinic and needs no verification.
          fromEmail: clinic.email_domain_status === 'verified' ? (clinic.chase_from_email ?? undefined) : undefined,
          replyTo: clinic.chase_reply_to ?? undefined,
        });
        await logInvoiceChase({ invoiceId: inv.id, clinicId, stage, channel: 'email', recipient: inv.contact_email, body: raw });
        sentAny = true;
      } catch (err: any) {
        console.error(`[chase] email failed for ${inv.invoice_number}:`, err?.message ?? err);
      }
    }

    if (sentAny) {
      await advanceInvoiceChase(inv.id, stage);
      chased++;
    }
  }

  if (chased) console.log(`[chase] ${chased}/${invoices.length} invoice(s) chased for ${senderName}`);
  return chased;
}
