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
import { sendProactiveWhatsApp, sendMarketingWhatsApp } from '../lib/twilio';
import { callState } from '../lib/callState';
import { buildConversationRelayTwiml } from './voiceRelay';
import { buildMediaStreamTwiml } from './mediaStream';

// Twilio TTS voice names are provider-prefixed (see the Say voices table).
// Polly.Ayanda-Generative = AWS Polly South African English (female), the
// GENERATIVE tier — most human-like / least robotic (Neural sounded flat & "American").
// Afrikaans replies use Google's af-ZA voice for correct pronunciation.
const SA_ENGLISH_VOICE = 'Polly.Ayanda-Generative' as any;
const AFRIKAANS_VOICE = 'Google.af-ZA-Standard-A' as any;
// Speech-RECOGNITION language for <Gather>. en-ZA is NOT a supported Gather
// language (and af-ZA recognition is unconfirmed), so we recognise as en-GB —
// good for SA English accents. Afrikaans support here can be revisited later.
const RECOGNITION_LANG = 'en-GB' as any;
// Bias speech recognition toward the words callers actually say at a clinic.
// (comma-separated entries, max 500 — improves accuracy a lot on phone audio)
const SPEECH_HINTS = [
  'Botox', 'filler', 'dermal filler', 'lip filler', 'consultation', 'chemical peel',
  'microneedling', 'laser', 'skin treatment', 'facial',
  'book an appointment', 'make a booking', 'reschedule', 'cancel', 'confirm',
  'yes', 'no', 'today', 'tomorrow', 'morning', 'afternoon', 'next week',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
].join(', ');
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

/** Build a gather-loop TwiML: say `text` (in the reply language's voice), then listen. */
function gatherReply(text: string, lang: 'en-GB' | 'af-ZA'): string {
  const vr = voiceResponse();
  const gather = vr.gather({
    input: ['speech'],
    action: '/webhooks/voice/gather',
    method: 'POST',
    language: RECOGNITION_LANG, // recognition stays en-GB regardless of reply language
    speechModel: 'phone_call', // telephony-optimized model
    enhanced: true, // premium phone_call model — ~54% fewer errors on phone audio (en-GB supported)
    hints: SPEECH_HINTS,
    speechTimeout: 'auto',
  } as any);
  const voice = lang === 'af-ZA' ? AFRIKAANS_VOICE : SA_ENGLISH_VOICE;
  gather.say({ voice }, text);
  // Fallback if caller stays silent: redirect back to gather
  vr.redirect({ method: 'POST' }, '/webhooks/voice/gather');
  return vr.toString();
}

/**
 * Language gate: greet, then let the caller pick English or Afrikaans (by saying it
 * or pressing a key). English → ConversationRelay (high quality); Afrikaans → the
 * Azure media-stream pipeline (af-ZA STT/TTS, lesser quality). We must choose the
 * pipeline up front because the inbound webhook fires before the caller speaks.
 */
function buildLanguageGateTwiml(clinic: any): string {
  const name = clinic?.name ?? 'us';
  const vr = voiceResponse();
  const gather = vr.gather({
    input: ['speech', 'dtmf'],
    numDigits: 1,
    action: '/webhooks/voice/route',
    method: 'POST',
    language: RECOGNITION_LANG,
    hints: 'English, Afrikaans, een, twee',
    speechTimeout: 'auto',
    actionOnEmptyResult: true, // no choice → still POST to /route, which defaults to English
  } as any);
  gather.say({ voice: SA_ENGLISH_VOICE }, `Hello, and thanks for calling ${name}. To carry on in English, say English or press 1.`);
  gather.say({ voice: AFRIKAANS_VOICE, language: 'af-ZA' } as any, 'Vir Afrikaans, sê Afrikaans, of druk twee.');
  return vr.toString();
}

/**
 * POST /webhooks/voice/route — second webhook, after the language gate. Routes the
 * caller to the right voice engine based on their spoken/keyed choice. Fails safe to
 * English ConversationRelay on anything ambiguous or on error.
 */
export async function handleVoiceRoute(req: Request, res: Response) {
  const to: string = req.body.To ?? '';
  const from: string = req.body.From ?? '';
  const callSid: string = req.body.CallSid;
  try {
    const clinic = (await getClinicByNumber(to)) ?? (await getClinic(config.defaultClinicId));
    if (!clinic) {
      const vr = voiceResponse();
      vr.say({ voice: SA_ENGLISH_VOICE }, "Sorry, this line isn't set up yet. Please try again later.");
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }
    const digits = String(req.body.Digits ?? '').trim();
    const speech = String(req.body.SpeechResult ?? '').toLowerCase();
    const wantsAfrikaans = digits === '2' || /afrikaan/.test(speech) || detectAfrikaans(speech);
    if (wantsAfrikaans) {
      // Afrikaans → Azure media-stream (af-ZA forced so it honours the explicit choice).
      return res.type('text/xml').send(buildMediaStreamTwiml(clinic, from, callSid, 'af'));
    }
    // English (digit 1, said "English", or no clear choice) → ConversationRelay.
    return res.type('text/xml').send(buildConversationRelayTwiml(clinic, from));
  } catch (e) {
    console.error('[voice] route error — falling back to English', e);
    try {
      const clinic = (await getClinicByNumber(to)) ?? (await getClinic(config.defaultClinicId));
      if (clinic) return res.type('text/xml').send(buildConversationRelayTwiml(clinic, from));
    } catch { /* */ }
    const vr = voiceResponse();
    vr.say({ voice: SA_ENGLISH_VOICE }, 'Sorry, something went wrong. Please call back in a moment.');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
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

    // Natural-voice mode: greet + offer a language choice, then route English →
    // ConversationRelay (high quality) or Afrikaans → Azure media-stream pipeline.
    if (config.voice.mode === 'conversationrelay') {
      return res.type('text/xml').send(buildLanguageGateTwiml(clinic));
    }
    // Custom pipeline mode: stream raw audio to our Media Streams WS (own STT/TTS).
    if (config.voice.mode === 'mediastream') {
      return res.type('text/xml').send(buildMediaStreamTwiml(clinic, from, callSid));
    }

    const { client: customer, isNew } = await getOrCreateClient(clinic.id, from);
    const convo = await getOrCreateConversation(clinic.id, customer.id);

    callState.init(callSid, {
      clinicId: clinic.id,
      clientId: customer.id,
      conversationId: convo.id,
      language: 'en-GB',
      isFirstTurn: isNew,
    });

    const greeting = `Thanks for calling ${clinic.name}. I'm Remi, the virtual assistant. How can I help you today?`;
    res.type('text/xml').send(gatherReply(greeting, 'en-GB'));
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
    const lang: 'en-GB' | 'af-ZA' = detectAfrikaans(speechResult) ? 'af-ZA' : session.language;
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
        await sendMarketingWhatsApp(clinic.id, whatsappTo, {
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
