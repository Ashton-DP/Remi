import { Request, Response } from 'express';
import { config } from '../config';
import {
  getClinic,
  getOrCreateClient,
  getOrCreateConversation,
  saveMessage,
  getHistory,
} from '../db';
import { runAgent } from '../brain/agent';
import { twimlReply } from '../lib/twilio';

/** Twilio inbound WhatsApp webhook (application/x-www-form-urlencoded). */
export async function handleInboundWhatsApp(req: Request, res: Response) {
  try {
    const from = String(req.body.From ?? '');
    const body = String(req.body.Body ?? '').trim();

    const clinic = await getClinic(config.defaultClinicId);
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
    console.error('[whatsapp] inbound error', e);
    res
      .type('text/xml')
      .send(twimlReply('Sorry, something went wrong — a team member will get back to you.'));
  }
}
