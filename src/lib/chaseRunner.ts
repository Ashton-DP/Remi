/**
 * Invoice chase runner — the outbound loop (ported from PaidUp's chaser).
 *
 * For each clinic: walk its chaseable invoices, work out the due stage, generate
 * a message, and send it over Remi's existing channel (WhatsApp or SMS) while
 * honouring the per-clinic kill switch and the opt-out suppression list. Every
 * send is logged and the invoice's chase stage advanced.
 *
 * Email is intentionally out of scope for this slice — Remi sends over Twilio
 * (WhatsApp/SMS) today; an email channel can layer on later.
 */
import { config } from '../config';
import {
  getClinic, getChaseableInvoices, advanceInvoiceChase, logInvoiceChase, isSuppressed,
} from '../db';
import { sendProactiveWhatsApp } from './twilio';
import { generateChaseMessage } from './chaseMessage';
import { nextChaseStage, daysOverdue, phoneKey, DEFAULT_CADENCE, type ChaseCadence } from './chase';

export async function runChaseForClinic(clinicId: string): Promise<number> {
  const clinic = await getClinic(clinicId);
  if (!clinic) return 0;
  if (clinic.chasing_paused) {
    console.log(`[chase] paused for ${clinic.name ?? clinicId} — skipping`);
    return 0;
  }

  const cadence: ChaseCadence = clinic.chase_cadence ?? DEFAULT_CADENCE;
  const senderName: string = clinic.name ?? 'our team';
  const channel = config.twilio.channel; // 'whatsapp' | 'sms'
  const invoices = await getChaseableInvoices(clinicId);
  let chased = 0;

  for (const inv of invoices as any[]) {
    const overdue = daysOverdue(inv.due_date);
    const stage = nextChaseStage(
      { days_overdue: overdue, chase_stage: inv.chase_stage ?? 0, last_chased_at: inv.last_chased_at, snoozed_until: inv.snoozed_until },
      cadence,
    );
    if (!stage) continue;

    const phone = inv.contact_phone;
    if (!phone) continue; // no Twilio-reachable contact in this slice
    if (await isSuppressed(clinicId, channel, phoneKey(phone))) continue;

    try {
      const body = await generateChaseMessage({
        contactName: inv.contact_name, invoiceNumber: inv.invoice_number, amount: inv.amount_due,
        currency: inv.currency, daysOverdue: overdue, dueDate: inv.due_date, stage, senderName, channel,
      });
      await sendProactiveWhatsApp(phone, { fallbackBody: body });
      await logInvoiceChase({ invoiceId: inv.id, clinicId, stage, channel, recipient: phone, body });
      await advanceInvoiceChase(inv.id, stage);
      chased++;
    } catch (err: any) {
      console.error(`[chase] failed invoice ${inv.invoice_number}:`, err?.message ?? err);
    }
  }

  if (chased) console.log(`[chase] ${chased}/${invoices.length} invoice(s) chased for ${senderName}`);
  return chased;
}
