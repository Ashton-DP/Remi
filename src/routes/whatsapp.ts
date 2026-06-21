import { Request, Response } from 'express';
import { config } from '../config';
import {
  getClinic,
  getClinicByNumber,
  getOrCreateClient,
  getOrCreateConversation,
  saveMessage,
  getHistory,
  markProcessedOnce,
} from '../db';
import { runAgent } from '../brain/agent';
import { twimlReply } from '../lib/twilio';
import { captureError } from '../lib/monitoring';

/** Twilio inbound WhatsApp webhook (application/x-www-form-urlencoded). */
export async function handleInboundWhatsApp(req: Request, res: Response) {
  try {
    const from = String(req.body.From ?? '');
    const body = String(req.body.Body ?? '').trim();

    // Idempotency: Twilio retries inbound webhooks (e.g. on slow/5xx responses).
    // Skip a message we've already handled so we don't double-book or double-reply.
    const sid = String(req.body.MessageSid ?? req.body.SmsMessageSid ?? '');
    if (sid && !(await markProcessedOnce(sid))) {
      console.log(`[whatsapp] duplicate webhook ${sid} ignored`);
      // Empty TwiML response = "no reply", and tells Twilio to stop retrying.
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    const to = String(req.body.To ?? '');
    const clinic = (await getClinicByNumber(to)) ?? (await getClinic(config.defaultClinicId));
    if (!clinic) {
      res.type('text/xml').send(twimlReply('Sorry, this number is not set up yet.'));
      return;
    }

    const { client: customer, isNew } = await getOrCreateClient(clinic.id, from);
    const convo = await getOrCreateConversation(clinic.id, customer.id);

    // POPIA opt-out
    if (/^stop$/i.test(body)) {
      res.type('text/xml').send(twimlReply("You've been unsubscribed. Reply START to opt back in."));
      return;
    }

    await saveMessage(convo.id, 'in', body);
    const history = await getHistory(convo.id);
    const reply = await runAgent(clinic, customer, convo, history, isNew);
    await saveMessage(convo.id, 'out', reply);

    res.type('text/xml').send(twimlReply(reply));
  } catch (e) {
    captureError(e, { route: 'whatsapp.inbound', from: String(req.body?.From ?? '') });
    res
      .type('text/xml')
      .send(twimlReply('Sorry, something went wrong — a team member will get back to you.'));
  }
}
