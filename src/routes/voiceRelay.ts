import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import {
  getClinic,
  getOrCreateClient,
  getOrCreateConversation,
  saveMessage,
  getHistory,
} from '../db';
import { runAgent } from '../brain/agent';

/**
 * Normalize text for natural speech (TTS reads symbols/numbers literally otherwise).
 * "R3,000" / "R3000" / "R3 000" → "3000 rand" so it's spoken "three thousand rand".
 */
export function speechNormalize(text: string): string {
  return String(text ?? '').replace(
    /R\s?(\d{1,3}(?:[, ]\d{3})+|\d+)/g,
    (_m, num: string) => `${num.replace(/[, ]/g, '')} rand`,
  );
}

/** XML-escape a value for safe inclusion in TwiML attributes/text. */
function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the inbound TwiML that hands the call to ConversationRelay — a real-time
 * WebSocket bridge where Twilio does ASR/TTS (ElevenLabs natural voice) and our
 * WS server runs the AI. The clinic + caller are passed as <Parameter>s so the
 * WS handler has context without re-deriving it.
 */
export function buildConversationRelayTwiml(clinic: any, from: string): string {
  const greeting = speechNormalize(
    `Thanks for calling ${clinic?.name ?? 'the clinic'}. I'm Remi, the virtual assistant. How can I help you today?`,
  );
  // Append an ElevenLabs model suffix (e.g. turbo_v2_5) if configured, for a more
  // natural voice than the default flash model.
  const voice = config.voice.elevenLabsModel
    ? `${config.voice.elevenLabsVoiceId}-${config.voice.elevenLabsModel}`
    : config.voice.elevenLabsVoiceId;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <ConversationRelay url="${xmlEscape(config.voice.wsUrl)}"` +
      ` welcomeGreeting="${xmlEscape(greeting)}"` +
      ` ttsProvider="${xmlEscape(config.voice.ttsProvider)}"` +
      ` voice="${xmlEscape(voice)}"` +
      ` transcriptionProvider="${xmlEscape(config.voice.transcriptionProvider)}"` +
      ` elevenlabsTextNormalization="on"` +
      ` language="en-GB" interruptByDtmf="true">`,
    `      <Parameter name="clinicId" value="${xmlEscape(clinic?.id ?? '')}"/>`,
    `      <Parameter name="from" value="${xmlEscape(from)}"/>`,
    '    </ConversationRelay>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

interface RelaySession {
  clinic: any;
  customer: any;
  convo: { id: string };
  isFirstTurn: boolean;
  busy: boolean;
}

/** Attach the ConversationRelay WebSocket server to the shared HTTP server. */
export function attachVoiceRelay(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws/voice' });

  wss.on('connection', (ws: WebSocket) => {
    let session: RelaySession | null = null;

    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // First message: initialise the session from the call's <Parameter>s.
      if (msg.type === 'setup') {
        try {
          const params = msg.customParameters ?? {};
          const clinicId = params.clinicId || config.defaultClinicId;
          const from = params.from || msg.from || '';
          const clinic = await getClinic(clinicId);
          const { client: customer, isNew } = await getOrCreateClient(clinic.id, from);
          const convo = await getOrCreateConversation(clinic.id, customer.id);
          session = { clinic, customer, convo, isFirstTurn: isNew, busy: false };
        } catch (e) {
          console.error('[voiceRelay] setup error', e);
        }
        return;
      }

      // Caller finished speaking → run the AI and speak the reply.
      if (msg.type === 'prompt' && session) {
        const text = String(msg.voicePrompt ?? '').trim();
        if (!text || session.busy) return;
        session.busy = true;
        try {
          await saveMessage(session.convo.id, 'in', text);
          const history = await getHistory(session.convo.id);
          const reply = await runAgent(
            session.clinic,
            session.customer,
            session.convo,
            history,
            session.isFirstTurn,
            true, // isVoice
          );
          session.isFirstTurn = false;
          await saveMessage(session.convo.id, 'out', reply);
          ws.send(JSON.stringify({ type: 'text', token: speechNormalize(reply), last: true }));
        } catch (e) {
          console.error('[voiceRelay] prompt error', e);
          ws.send(
            JSON.stringify({
              type: 'text',
              token: "Sorry, I'm having a little trouble — could you say that again?",
              last: true,
            }),
          );
        } finally {
          session.busy = false;
        }
        return;
      }

      if (msg.type === 'error') {
        console.error('[voiceRelay] CR error:', msg.description);
      }
    });

    ws.on('close', () => {
      session = null;
    });
  });

  console.log('[voiceRelay] ConversationRelay WebSocket attached at /ws/voice');
}
