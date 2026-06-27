/**
 * Email triage — decide whether an inbound email is a genuine client enquiry the
 * front desk should answer, BEFORE we let the booking brain reply.
 *
 * Critical safety rail: Remi reads the clinic's whole inbox, so without triage it
 * would reply to newsletters, suppliers, invoices, spam and automated mail. We
 * run cheap deterministic filters first, then a light Gemini classification, and
 * DEFAULT TO NOT REPLYING when unsure.
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import type { InboundEmail } from './emailInbox';

const SKIP_FROM = [
  'no-reply', 'noreply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'bounce', 'notifications@', 'notification@',
  'newsletter', 'mailchimp', 'sendgrid.net', 'mailgun', 'updates@', 'support@',
];

export interface TriageResult {
  handle: boolean;
  reason: string;
}

/** Deterministic pre-filters — no AI call. Returns a reason to skip, or null. */
export function preFilter(email: InboundEmail, ownMailbox: string): string | null {
  const from = (email.fromAddress || '').toLowerCase();
  if (!from || !from.includes('@')) return 'no valid sender';
  if (from === (ownMailbox || '').toLowerCase()) return 'from our own mailbox (loop)';
  if (email.autoSubmitted) return 'automated/bulk message';
  if (SKIP_FROM.some((s) => from.includes(s))) return `sender looks automated (${from})`;
  if (!email.text || email.text.length < 2) return 'empty body';
  return null;
}

/**
 * Full triage: pre-filters, then Gemini classification. Returns {handle:false}
 * (safe default) on any ambiguity or error — better to leave an email for a human
 * than to have Remi reply to something it shouldn't.
 */
export async function triageEmail(
  email: InboundEmail,
  ownMailbox: string,
  clinicName: string,
): Promise<TriageResult> {
  const skip = preFilter(email, ownMailbox);
  if (skip) return { handle: false, reason: skip };

  if (!config.gemini.apiKey) return { handle: false, reason: 'no AI key — cannot classify' };

  try {
    const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    const prompt =
      `You triage emails arriving in the inbox of "${clinicName}", a service business (clinic/salon).\n` +
      `Decide if this email is from a CLIENT or PATIENT and is about booking, rescheduling, cancelling, ` +
      `confirming, or asking about an appointment, availability, pricing, or the services offered — i.e. ` +
      `something the front desk should reply to.\n` +
      `Answer false for: newsletters, marketing, supplier/vendor mail, invoices or bills, recruitment, ` +
      `automated notifications, spam, or personal/internal mail.\n` +
      `Reply with STRICT JSON only: {"handle": true or false, "reason": "<short>"}\n\n` +
      `Subject: ${email.subject}\nFrom: ${email.fromName} <${email.fromAddress}>\nBody:\n${email.text.slice(0, 2000)}`;
    const r: any = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const raw = (r.text ?? '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { handle: false, reason: 'classifier returned no JSON' };
    const parsed = JSON.parse(m[0]);
    return { handle: parsed.handle === true, reason: String(parsed.reason ?? '') };
  } catch (e) {
    return { handle: false, reason: `classifier error: ${(e as Error)?.message ?? e}` };
  }
}
