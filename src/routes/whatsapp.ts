import { Request, Response } from 'express';
import { config } from '../config';
import {
  getClinic,
  getClinicByNumber,
  getStaffByPhone,
  getOrCreateClient,
  getOrCreateConversation,
  saveMessage,
  getHistory,
  markProcessedOnce,
  unmarkProcessed,
  addSuppression,
  removeSuppression,
} from '../db';
import { phoneKey } from '../lib/chase';
import { runAgent } from '../brain/agent';
import { runStaffAgent } from '../brain/staffAgent';
import { twimlReply } from '../lib/twilio';
import { captureError } from '../lib/monitoring';
import { tryHandleInvoiceReply } from '../lib/chaseReply';
import { transcribeTwilioAudio } from '../lib/transcribe';

/** Twilio inbound WhatsApp webhook (application/x-www-form-urlencoded). */
export async function handleInboundWhatsApp(req: Request, res: Response) {
  // Hoisted so the catch can release the idempotency record on failure.
  let sid = '';
  try {
    const from = String(req.body.From ?? '');
    let body = String(req.body.Body ?? '').trim();

    // Idempotency: Twilio retries inbound webhooks (e.g. on slow/5xx responses).
    // Skip a message we've already handled so we don't double-book or double-reply.
    sid = String(req.body.MessageSid ?? req.body.SmsMessageSid ?? '');
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

    // Staff mode: if this phone belongs to a team member, route to the staff
    // brain (clock in/out, hours, leave) — never the client booking brain.
    if (body) {
      const staff = await getStaffByPhone(clinic.id, from);
      if (staff) {
        const reply = await runStaffAgent(clinic, staff, [{ role: 'user', content: body }]);
        res.type('text/xml').send(twimlReply(reply));
        return;
      }
    }

    const { client: customer, isNew } = await getOrCreateClient(clinic.id, from);
    const convo = await getOrCreateConversation(clinic.id, customer.id);

    // Voice note → transcribe it (Gemini, EN/AF) and treat the transcript as the
    // message body so the normal brain flow runs. If transcription yields nothing
    // we fall through to the media guard below and ask them to type.
    const numMedia = parseInt(String(req.body.NumMedia ?? '0'), 10) || 0;
    const mediaType = String(req.body.MediaContentType0 ?? '');
    const mediaUrl = String(req.body.MediaUrl0 ?? '');
    if (!body && numMedia > 0 && mediaType.startsWith('audio') && mediaUrl) {
      const transcript = await transcribeTwilioAudio(mediaUrl, mediaType);
      if (transcript) body = transcript;
    }

    // Invoice chase reply? (paid / snooze / dispute / stop from a recently-chased
    // contact). Handled directly — never routed to the receptionist brain. Returns
    // null for ordinary messages, which fall through to the normal flow below.
    const invoiceReply = await tryHandleInvoiceReply(clinic.id, from, body);
    if (invoiceReply) {
      await saveMessage(convo.id, 'in', body);
      await saveMessage(convo.id, 'out', invoiceReply);
      res.type('text/xml').send(twimlReply(invoiceReply));
      return;
    }

    // POPIA opt-out — actually record the suppression (both channels), so proactive
    // marketing sends skip this contact. START reverses it.
    if (/^stop$/i.test(body)) {
      const key = phoneKey(from);
      await addSuppression(clinic.id, 'whatsapp', key, 'stop');
      await addSuppression(clinic.id, 'sms', key, 'stop');
      res.type('text/xml').send(twimlReply("You've been unsubscribed. Reply START to opt back in."));
      return;
    }
    if (/^start$/i.test(body)) {
      const key = phoneKey(from);
      await removeSuppression(clinic.id, 'whatsapp', key);
      await removeSuppression(clinic.id, 'sms', key);
      res.type('text/xml').send(twimlReply("You're opted back in 👍 Reply STOP any time to unsubscribe."));
      return;
    }

    // Still no text — a media message we can't read (image, sticker, location) or
    // a voice note we couldn't transcribe. Reply helpfully and skip the brain.
    if (!body) {
      const reply = numMedia > 0 && mediaType.startsWith('audio')
        ? "I couldn't quite make out that voice note — could you try again, or type your message? 🙏"
        : numMedia > 0
          ? "Thanks! I can't open attachments yet — please type what you need and I'll help right away. 🙏"
          : "Sorry, I didn't get any text there — could you type your message?";
      await saveMessage(convo.id, 'in', numMedia > 0 ? `[${mediaType || 'media'} message]` : '[empty message]');
      await saveMessage(convo.id, 'out', reply);
      res.type('text/xml').send(twimlReply(reply));
      return;
    }

    await saveMessage(convo.id, 'in', body);
    const history = await getHistory(convo.id);
    const reply = await runAgent(clinic, customer, convo, history, isNew);
    await saveMessage(convo.id, 'out', reply);

    res.type('text/xml').send(twimlReply(reply));
  } catch (e) {
    // Processing failed AFTER we recorded the SID — release it so Twilio's retry
    // can re-run instead of being deduped into oblivion (no lost messages).
    if (sid) await unmarkProcessed(sid);
    captureError(e, { route: 'whatsapp.inbound', from: String(req.body?.From ?? '') });
    res
      .type('text/xml')
      .send(twimlReply('Sorry, something went wrong — a team member will get back to you.'));
  }
}
