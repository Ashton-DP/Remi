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
/**
 * Pure builder for the Twilio message params, channel-aware (testable).
 * - WhatsApp: uses the approved template (contentSid) when present, else free text.
 * - SMS: templates don't apply, so it always sends plain `fallbackBody` from the
 *   SMS number, with any `whatsapp:` prefix stripped off the recipient.
 * Returns null if the chosen channel has no sender configured.
 */
export function buildProactiveParams(
  channel: 'whatsapp' | 'sms',
  to: string,
  opts: { contentSid?: string; variables?: Record<string, string>; fallbackBody: string },
  froms: { whatsappFrom?: string; smsFrom?: string },
): Record<string, string> | null {
  if (channel === 'sms') {
    if (!froms.smsFrom) return null;
    return { from: froms.smsFrom, to: to.replace(/^whatsapp:/, ''), body: opts.fallbackBody };
  }
  if (opts.contentSid) {
    return {
      from: froms.whatsappFrom ?? '',
      to,
      contentSid: opts.contentSid,
      contentVariables: JSON.stringify(opts.variables ?? {}),
    };
  }
  return { from: froms.whatsappFrom ?? '', to, body: opts.fallbackBody };
}

export async function sendProactiveWhatsApp(
  to: string,
  opts: { contentSid?: string; variables?: Record<string, string>; fallbackBody: string },
) {
  const channel = config.twilio.channel;
  if (!client || !to) {
    console.log(`[${channel}→${to || 'unknown'}] ${opts.fallbackBody}`);
    return;
  }
  const params = buildProactiveParams(channel, to, opts, {
    whatsappFrom: config.twilio.whatsappFrom,
    smsFrom: config.twilio.smsFrom,
  });
  if (!params) {
    console.warn(`[${channel}] no sender configured — set TWILIO_SMS_FROM. Logging only.`);
    console.log(`[${channel}→${to}] ${opts.fallbackBody}`);
    return;
  }
  return client.messages.create(params as any);
}

/** Build a TwiML reply for synchronous webhook responses. */
export function twimlReply(text: string): string {
  const response = new twilio.twiml.MessagingResponse();
  response.message(text);
  return response.toString();
}
