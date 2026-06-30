import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import {
  getClinic,
  getOrCreateClient,
  getOrCreateConversation,
  saveMessage,
  getHistory,
} from '../db';
import { runAgentStream } from '../brain/agent';

/**
 * Normalize text for natural speech (TTS reads symbols/numbers literally otherwise).
 * "R3,000" / "R3000" / "R3 000" → "3000 rand" so it's spoken "three thousand rand".
 */
export function speechNormalize(text: string): string {
  let s = String(text ?? '');
  // Markdown links [label](url) → just the label.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip emphasis/code/heading markers so TTS doesn't read "asterisk" aloud.
  s = s.replace(/[*_`#]+/g, ' ');
  // Drop list-item markers at the start of lines.
  s = s.replace(/^\s*[-•]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  // "R300" / "R1,000" → "300 rand" so it's spoken correctly.
  s = s.replace(/R\s?(\d{1,3}(?:[, ]\d{3})+|\d+)/g, (_m, num: string) => `${num.replace(/[, ]/g, '')} rand`);
  // Collapse whitespace left behind.
  return s.replace(/\s+/g, ' ').trim();
}

/** XML-escape a value for safe inclusion in TwiML attributes/text. */
export function xmlEscape(s: string): string {
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
  // The language gate already said "thanks for calling <clinic>", so the in-call
  // greeting just introduces Remi and invites the request — no repeated thanks.
  const greeting = speechNormalize(
    `I'm Remi, the virtual assistant. How can I help you today?`,
  );
  const provider = config.voice.ttsProvider; // 'Google' (Chirp3-HD TTS)
  // English transcription: Deepgram Flux — fuses transcription with natural turn
  // detection so the agent stops cutting callers off / lagging on replies. (Afrikaans
  // can't use Deepgram/Flux — no af-ZA support — so it runs on the separate Azure
  // media-stream pipeline instead.)
  const stt = process.env.CR_STT_PROVIDER || 'Deepgram';
  const sttModel = process.env.CR_SPEECH_MODEL || 'flux-general-en';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <ConversationRelay url="${xmlEscape(config.voice.wsUrl)}"` +
      ` welcomeGreeting="${xmlEscape(greeting)}"` +
      ` ttsProvider="${xmlEscape(provider)}"` +
      ` voice="${xmlEscape(config.voice.crVoiceEn)}"` +
      ` transcriptionProvider="${xmlEscape(stt)}"` +
      ` speechModel="${xmlEscape(sttModel)}"` +
      ` language="${xmlEscape(config.voice.crLanguage)}">`,
    `      <Language code="${xmlEscape(config.voice.crLanguage)}" ttsProvider="${xmlEscape(provider)}" voice="${xmlEscape(config.voice.crVoiceEn)}" transcriptionProvider="${xmlEscape(stt)}" speechModel="${xmlEscape(sttModel)}"/>`,
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
  history: { role: string; content: string }[]; // in-memory transcript (no per-turn DB read)
}

/** Attach the ConversationRelay WebSocket server to the shared HTTP server. */
export function attachVoiceRelay() {
  // noServer mode: index.ts routes the HTTP 'upgrade' event by path, so this and the
  // media-stream WS can share one server without fighting over the handshake.
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    let session: RelaySession | null = null;
    let turns = 0;
    const maxTurns = parseInt(process.env.MAX_CALL_TURNS ?? '40', 10);
    // Absolute safety cap so a held-open socket can't run paid LLM turns forever.
    const maxTimer = setTimeout(() => { console.warn('[voiceRelay] max call duration reached — closing'); try { ws.close(); } catch { /* */ } },
      parseInt(process.env.MAX_CALL_MINUTES ?? '15', 10) * 60_000);
    maxTimer.unref?.();
    ws.on('close', () => clearTimeout(maxTimer));

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
          const history = await getHistory(convo.id); // loaded once; kept in memory thereafter
          session = { clinic, customer, convo, isFirstTurn: isNew, busy: false, history };
        } catch (e) {
          console.error('[voiceRelay] setup error', e);
        }
        return;
      }

      // Caller finished speaking → run the AI and speak the reply.
      if (msg.type === 'prompt' && session) {
        const text = String(msg.voicePrompt ?? '').trim();
        if (!text || session.busy) return;
        if (++turns > maxTurns) { console.warn('[voiceRelay] max turns reached — closing'); try { ws.close(); } catch { /* */ } return; }
        session.busy = true;
        const abort = { aborted: false };
        try {
          session.history.push({ role: 'user', content: text });
          void saveMessage(session.convo.id, 'in', text).catch((e) => console.error('[voiceRelay] saveMessage(in)', e));
          // Stream the reply sentence-by-sentence: ConversationRelay starts speaking the
          // first sentence while the rest is still being generated — far lower latency
          // than waiting for the whole reply before saying a word.
          const reply = await runAgentStream(
            session.clinic, session.customer, session.convo, session.history, session.isFirstTurn, true,
            (sentence) => {
              const token = speechNormalize(sentence);
              if (token && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'text', token: token + ' ', last: false }));
              }
            },
            abort,
          );
          session.isFirstTurn = false;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
          if (reply) {
            session.history.push({ role: 'assistant', content: reply });
            void saveMessage(session.convo.id, 'out', reply).catch((e) => console.error('[voiceRelay] saveMessage(out)', e));
          }
        } catch (e) {
          console.error('[voiceRelay] prompt error', e);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'text', token: "Sorry, I'm having a little trouble — could you say that again?", last: true }));
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
  return wss;
}
