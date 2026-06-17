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

/** Build a TwiML reply for synchronous webhook responses. */
export function twimlReply(text: string): string {
  const response = new twilio.twiml.MessagingResponse();
  response.message(text);
  return response.toString();
}
