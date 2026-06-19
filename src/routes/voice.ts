import { Request, Response } from 'express';
import twilio from 'twilio';
import { config } from '../config';
import {
  getClinic,
  getClinicByNumber,
  getOrCreateClient,
  getOrCreateConversation,
  saveMessage,
  getHistory,
  logEvent,
} from '../db';
import { runAgent } from '../brain/agent';
import { sendProactiveWhatsApp } from '../lib/twilio';
import { callState } from '../lib/callState';

// Polly.Ayanda = AWS Polly South African English (female). Cast needed — SDK types lag.
const SA_ENGLISH_VOICE = 'Polly.Ayanda' as any;
const MISSED_CALL_STATUSES = new Set(['no-answer', 'busy', 'failed']);

/** Detect Afrikaans from common words in the caller's speech. */
function detectAfrikaans(text: string): boolean {
  return /\b(dankie|asseblief|goeie|môre|middag|aand|hoe gaan|baie|jammer|mooi|braai|lekker|ja nee|nee dankie)\b/i.test(
    text,
  );
}

function voiceResponse() {
  return new twilio.twiml.VoiceResponse();
}

/** Build a gather-loop TwiML: say `text`, then listen for speech. */
function gatherReply(text: string, lang: 'en-ZA' | 'af-ZA'): string {
  const vr = voiceResponse();
  const gather = vr.gather({
    input: ['speech'],
    action: '/webhooks/voice/gather',
    method: 'POST',
    language: lang,
    speechTimeout: 'auto',
  });
  gather.say({ voice: SA_ENGLISH_VOICE }, text);
  // Fallback if caller stays silent: redirect back to gather
  vr.redirect({ method: 'POST' }, '/webhooks/voice/gather');
  return vr.toString();
}

/** POST /webhooks/voice/inbound — first webhook when a call arrives. */
export async function handleInboundCall(req: Request, res: Response) {
  try {
    const callSid: string = req.body.CallSid;
    const from: string = req.body.From ?? '';
    const to: string = req.body.To ?? '';

    const clinic = (await getClinicByNumber(to)) ?? (await getClinic(config.defaultClinicId));
    if (!clinic) {
      const vr = voiceResponse();
      vr.say({ voice: SA_ENGLISH_VOICE }, "Sorry, this line isn't set up yet. Please try again later.");
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const { client: customer, isNew } = await getOrCreateClient(clinic.id, from);
    const convo = await getOrCreateConversation(clinic.id, customer.id);

    callState.init(callSid, {
      clinicId: clinic.id,
      clientId: customer.id,
      conversationId: convo.id,
      language: 'en-ZA',
      isFirstTurn: isNew,
    });

    const greeting = `Thanks for calling ${clinic.name}. I'm Remi, the virtual assistant. How can I help you today?`;
    res.type('text/xml').send(gatherReply(greeting, 'en-ZA'));
  } catch (e) {
    console.error('[voice] inbound error', e);
    const vr = voiceResponse();
    vr.say({ voice: SA_ENGLISH_VOICE }, 'Sorry, something went wrong. Please call back in a moment.');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
}

/** POST /webhooks/voice/gather — each speech turn in the conversation. */
export async function handleVoiceGather(req: Request, res: Response) {
  const callSid: string = req.body.CallSid;
  const speechResult: string = (req.body.SpeechResult ?? '').trim();

  const session = callState.get(callSid);
  if (!session) {
    // Session lost (e.g. server restart mid-call)
    const vr = voiceResponse();
    vr.say({ voice: SA_ENGLISH_VOICE }, "I'm sorry, I've lost track of our conversation. Please call back and I'll help you right away.");
    vr.hangup();
    return res.type('text/xml').send(vr.toString());
  }

  // No speech detected — reprompt
  if (!speechResult) {
    return res.type('text/xml').send(
      gatherReply("Sorry, I didn't catch that. Could you say that again?", session.language),
    );
  }

  try {
    const lang: 'en-ZA' | 'af-ZA' = detectAfrikaans(speechResult) ? 'af-ZA' : session.language;
    callState.update(callSid, { language: lang, isFirstTurn: false });

    const clinic = await getClinic(session.clinicId);
    const { client: customer } = await getOrCreateClient(session.clinicId, req.body.From ?? '');
    const convo = { id: session.conversationId };

    await saveMessage(session.conversationId, 'in', speechResult);
    const history = await getHistory(session.conversationId);

    const reply = await runAgent(clinic, customer, convo, history, session.isFirstTurn, true);
    await saveMessage(session.conversationId, 'out', reply);

    res.type('text/xml').send(gatherReply(reply, lang));
  } catch (e) {
    console.error('[voice] gather error', e);
    res.type('text/xml').send(
      gatherReply("I'm having a bit of trouble right now. Let me try again — what can I help you with?", session.language),
    );
  }
}

/**
 * POST /webhooks/voice/status — fires when a call ends.
 * If the call was missed (no-answer / busy / failed), text the caller on WhatsApp.
 */
export async function handleCallStatus(req: Request, res: Response) {
  const callSid: string = req.body.CallSid;
  const callStatus: string = req.body.CallStatus ?? '';
  const from: string = req.body.From ?? '';

  callState.end(callSid);

  if (MISSED_CALL_STATUSES.has(callStatus) && from) {
    try {
      const clinic = (await getClinicByNumber(req.body.To ?? '')) ?? (await getClinic(config.defaultClinicId));
      if (clinic) {
        const whatsappTo = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
        await sendProactiveWhatsApp(whatsappTo, {
          contentSid: config.templates.missedCall || undefined,
          variables: { '1': 'there', '2': clinic.name },
          fallbackBody: `Hi there 👋 You just called ${clinic.name} but we missed you. I'm Remi, the virtual assistant — I can help you book an appointment or answer any questions right here on WhatsApp. What can I help you with?`,
        });
        await logEvent(clinic.id, 'missed_call', 0);
        console.log(`[voice] missed call from ${from} — WhatsApp sent`);
      }
    } catch (e) {
      console.error('[voice] missed-call handler error', e);
    }
  }

  res.sendStatus(204);
}
