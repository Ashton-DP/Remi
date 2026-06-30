/**
 * Inbound chase-reply handling. When someone replies to a payment reminder with
 * "I've paid" / "next week" / "this is wrong" / "stop", apply it automatically:
 * mark paid, snooze, dispute, or opt out — and stop chasing accordingly.
 *
 * Only fires when the sender is actually a recently-chased contact AND the message
 * classifies as a chase reply, so ordinary customer messages fall through to the
 * receptionist brain untouched.
 */
import { classifyInvoiceReply, phoneKey } from './chase';
import {
  getOverdueChasedInvoices, markInvoicePaidById, snoozeInvoice, disputeInvoice, addSuppression, addTask,
} from '../db';

const SNOOZE_DAYS = 5;

/** Returns a reply to send if this was a chase reply we handled, else null. */
export async function tryHandleInvoiceReply(clinicId: string, fromPhone: string, body: string): Promise<string | null> {
  const intent = classifyInvoiceReply(body);
  if (intent === 'unknown') return null;

  const key = phoneKey(fromPhone);
  if (!key) return null;

  const all = await getOverdueChasedInvoices(clinicId);
  const mine = (all as any[]).filter((i) => phoneKey(i.contact_phone) === key);
  if (!mine.length) return null; // sender isn't a chased contact → let the brain handle it

  switch (intent) {
    case 'stop':
      await addSuppression(clinicId, 'whatsapp', key, 'stop');
      await addSuppression(clinicId, 'sms', key, 'stop');
      return "Done — you won't receive any more payment reminders from us. Thank you.";
    case 'paid': {
      // Single outstanding invoice → safe to mark it settled.
      if (mine.length === 1) {
        await markInvoicePaidById(mine[0].id);
        return "Thank you! 🙏 We've marked that as settled on our side — if anything's still outstanding we'll be in touch.";
      }
      // Multiple invoices outstanding → do NOT blanket-mark them all paid (that could
      // wrongly zero genuinely-unpaid invoices). Pause the chases briefly and flag the
      // clinic to reconcile which ones the payment actually covers.
      const until = new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString();
      for (const i of mine) await snoozeInvoice(i.id, until);
      await addTask(clinicId, {
        title: `Payment to reconcile — ${mine[0].contact_name ?? fromPhone}`,
        note: `${mine[0].contact_name ?? fromPhone} replied that they've paid, but has ${mine.length} overdue invoices (${mine.map((i) => i.invoice_number).join(', ')}). Chasing paused ${SNOOZE_DAYS} days — please confirm which are settled and mark them paid.`,
        source: 'chase-reply',
      });
      return "Thank you! 🙏 We've paused the reminders while we confirm which invoices that covers — we'll be in touch if anything's still outstanding.";
    }
    case 'dispute':
      for (const i of mine) await disputeInvoice(i.id);
      return "Thanks for flagging that — we've paused the reminders and a team member will be in touch to sort it out.";
    case 'snooze': {
      const until = new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString();
      for (const i of mine) await snoozeInvoice(i.id, until);
      return "No problem — we'll give you a few days. Thanks for letting us know!";
    }
    default:
      return null;
  }
}
