/**
 * Email sending for invoice chasing (ported from PaidUp's email.js).
 *
 * Sends via Resend (https://resend.com) when RESEND_API_KEY is set — one fetch,
 * no SDK. Falls back to console logging when unconfigured, so the chase flow is
 * testable before email is wired up (mirrors the Twilio sender's behaviour).
 */
import { config } from '../config';

/** Split an AI-generated email message into subject + body. Pure — tested. */
export function parseEmailMessage(raw: string): { subject: string; body: string } {
  const lines = String(raw || '').split('\n');
  const subjectLine = lines.find((l) => l.toLowerCase().startsWith('subject:'));
  const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : 'Invoice payment reminder';
  const body = lines.filter((l) => !l.toLowerCase().startsWith('subject:')).join('\n').trim();
  return { subject, body };
}

/** Branded HTML wrapper for a chase email. Pure. */
export function buildChaseEmailHtml(o: { senderName: string; invoiceNumber?: string | null; body: string; paymentUrl?: string | null }): string {
  const htmlBody = o.body
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const payButton = o.paymentUrl ? `
      <tr><td style="padding:0 32px 28px;text-align:center;">
        <a href="${o.paymentUrl}" style="display:inline-block;background:#16a34a;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;">Pay now →</a>
      </td></tr>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e4e7ef;">
      <tr><td style="background:#13151f;padding:20px 32px;">
        <p style="margin:0;color:#fff;font-size:16px;font-weight:bold;">${o.senderName}</p>
        ${o.invoiceNumber ? `<p style="margin:4px 0 0;color:#9aa3b2;font-size:12px;">Invoice ${o.invoiceNumber}</p>` : ''}
      </td></tr>
      <tr><td style="padding:32px;color:#1e2233;font-size:15px;">${htmlBody}</td></tr>
      ${payButton}
      <tr><td style="padding:0 32px 24px;border-top:1px solid #f0f0f3;">
        <p style="margin:16px 0 0;color:#9aa3b2;font-size:11px;">Automated payment reminder. If you've already paid, please disregard. To stop these reminders, reply "STOP".</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/**
 * Low-level send. Resend if configured, else console log.
 *
 * The email goes out AS THE CLINIC, never as Remi:
 *  - `fromName`  = the clinic's name (the display name the recipient sees)
 *  - `fromEmail` = the clinic's own verified-domain address when set (true
 *                  white-label); otherwise Remi's verified sending domain
 *  - `replyTo`   = the clinic's email, so replies go to the clinic, not us
 */
export async function sendEmail(o: {
  to: string; toName?: string | null; subject: string; text: string; html: string;
  fromName?: string; fromEmail?: string | null; replyTo?: string | null;
}) {
  const key = config.email.resendApiKey;
  const fromName = o.fromName || 'Remi';
  const fromEmail = o.fromEmail || config.email.fromEmail;
  if (!key) {
    console.log(`[email] (not configured — logging) from "${fromName}" <${fromEmail}> → ${o.to} · ${o.subject}`);
    return;
  }
  const payload: any = {
    from: `${fromName} <${fromEmail}>`,
    to: [o.toName ? `${o.toName} <${o.to}>` : o.to],
    subject: o.subject,
    text: o.text,
    html: o.html,
  };
  if (o.replyTo) payload.reply_to = [o.replyTo];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data?.message || ''}`);
  return data;
}

/** Send a chase email AS THE CLINIC: parse subject/body, wrap in HTML, send. */
export async function sendChaseEmail(o: {
  to: string; toName?: string | null; rawMessage: string; invoiceNumber?: string | null;
  senderName: string; paymentUrl?: string | null; fromEmail?: string | null; replyTo?: string | null;
}) {
  const { subject, body } = parseEmailMessage(o.rawMessage);
  const html = buildChaseEmailHtml({ senderName: o.senderName, invoiceNumber: o.invoiceNumber, body, paymentUrl: o.paymentUrl });
  await sendEmail({
    to: o.to, toName: o.toName, subject, text: body, html,
    fromName: o.senderName, fromEmail: o.fromEmail, replyTo: o.replyTo,
  });
}
