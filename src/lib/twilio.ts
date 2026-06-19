import twilio from 'twilio';
import { config } from '../config';

const enabled = Boolean(config.twilio.accountSid && config.twilio.authToken);
const client = enabled ? twilio(config.twilio.accountSid, config.twilio.authToken) : null;

/**
 * Send a proactive WhatsApp message (reminders, missed-call follow-ups, waitlist offers).
 * Falls back to console logging when Twilio isn't configured, so the flow is testable
 * before WhatsApp is wired up.
 */
export async function sendWhatsApp(to: string, body: string) {
  if (!client || !to) {
    console.log(`[whatsapp→${to || 'unknown'}] ${body}`);
    return;
  }
  return client.messages.create({ from: config.twilio.whatsappFrom, to, body });
}

/**
 * Send a proactive (business-initiated) WhatsApp message.
 *
 * On the WhatsApp Business API, messages sent outside the 24h customer-service
 * window MUST use a pre-approved template. So when a `contentSid` (HX…) is
 * provided we send by template (contentSid + contentVariables); otherwise we
 * fall back to free-form `fallbackBody`, which works in the sandbox and inside
 * the 24h window. This lets the same code run pre- and post-approval — just set
 * the template Content SIDs in env once Meta approves them.
 */
export async function sendProactiveWhatsApp(
  to: string,
  opts: { contentSid?: string; variables?: Record<string, string>; fallbackBody: string },
) {
  if (!client || !to) {
    console.log(`[whatsapp→${to || 'unknown'}] ${opts.fallbackBody}`);
    return;
  }
  if (opts.contentSid) {
    return client.messages.create({
      from: config.twilio.whatsappFrom,
      to,
      contentSid: opts.contentSid,
      contentVariables: JSON.stringify(opts.variables ?? {}),
    });
  }
  return client.messages.create({ from: config.twilio.whatsappFrom, to, body: opts.fallbackBody });
}

/** Build a TwiML reply for synchronous webhook responses. */
export function twimlReply(text: string): string {
  const response = new twilio.twiml.MessagingResponse();
  response.message(text);
  return response.toString();
}
