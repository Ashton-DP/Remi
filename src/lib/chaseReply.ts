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
  getOverdueChasedInvoices, markInvoicePaidById, snoozeInvoice, disputeInvoice, addSuppression,
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
    case 'paid':
      for (const i of mine) await markInvoicePaidById(i.id);
      return "Thank you! 🙏 We've marked that as settled on our side — if anything's still outstanding we'll be in touch.";
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
