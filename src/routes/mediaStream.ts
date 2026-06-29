import type { Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { speechNormalize, xmlEscape } from './voiceRelay';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import {
  azureSpeechEnabled, createAzureRecognizer, azureSynthesize, detectAfrikaans, detectZulu,
  type AzureRecognizer, type AzureSynthesis,
} from '../voice/azureSpeech';

// Prefer Azure (en-ZA/af-ZA/zu-ZA STT auto-detect + natural neural voices) when
// configured; otherwise fall back to the Deepgram + ElevenLabs pipeline.
const USE_AZURE = azureSpeechEnabled();

/**
 * Custom voice pipeline using Twilio Media Streams (raw audio) + our OWN providers:
 *   caller audio → Deepgram (streaming STT) → Gemini (runAgent) → ElevenLabs (TTS, μ-law 8k) → caller
 * Gives full control: any ElevenLabs voice + barge-in. Heavier than ConversationRelay.
 *
 * Gated behind VOICE_MODE=mediastream.
 */

// ── Media-stream auth ─────────────────────────────────────────────────────────
// The /ws/media socket is public and Twilio Media Streams cannot send custom
// headers, so we mint a short-lived HMAC token (signed with the Twilio auth token)
// into the TwiML <Parameter>s and verify it in the `start` frame. This binds the
// connection to the exact clinicId+from+callSid the TwiML was generated for, so a
// stranger can't connect, forge an arbitrary clinic/caller, write conversation
// history, or burn billable STT/LLM/TTS. Twilio connects within seconds of the
// TwiML response, so a short TTL is plenty.
const MEDIA_TOKEN_TTL_MS = 5 * 60_000;

function signMediaToken(clinicId: string, from: string, callSid: string, exp: number): string {
  return createHmac('sha256', config.twilio.authToken)
    .update(`${clinicId}.${from}.${callSid}.${exp}`)
    .digest('base64url');
}

/** Constant-time verify of the media-stream params; returns true iff valid & unexpired. */
function verifyMediaToken(p: { clinicId?: string; from?: string; callSid?: string; exp?: string; token?: string }): boolean {
  const exp = parseInt(p.exp ?? '', 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  if (!p.token) return false;
  const expected = signMediaToken(p.clinicId ?? '', p.from ?? '', p.callSid ?? '', exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(p.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** TwiML that streams the call's raw audio to our /ws/media WebSocket (HMAC-gated). */
export function buildMediaStreamTwiml(clinic: any, from: string, callSid: string): string {
  const clinicId = clinic?.id ?? '';
  const exp = Date.now() + MEDIA_TOKEN_TTL_MS;
  const token = signMediaToken(clinicId, from, callSid, exp);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${xmlEscape(config.voice.mediaWsUrl)}">`,
    `      <Parameter name="clinicId" value="${xmlEscape(clinicId)}"/>`,
    `      <Parameter name="from" value="${xmlEscape(from)}"/>`,
    `      <Parameter name="callSid" value="${xmlEscape(callSid)}"/>`,
    `      <Parameter name="exp" value="${exp}"/>`,
    `      <Parameter name="token" value="${token}"/>`,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

interface CallCtx {
  streamSid: string;
  clinic: any;
  customer: any;
  convo: { id: string };
  isFirstTurn: boolean;
  dg: WebSocket | null; // Deepgram STT socket (fallback path)
  azureStt: AzureRecognizer | null; // Azure STT (preferred path)
  azureTts: AzureSynthesis | null;  // in-flight Azure TTS (for barge-in)
  turnAbort: { aborted: boolean } | null; // aborts the in-flight streamed turn
  botSpeaking: boolean;
  thinking: boolean;
  ttsAbort: AbortController | null;
  closed: boolean;
  lang: 'en' | 'af' | 'zu'; // caller's current language (from STT auto-detect)
}

const DG_URL = () =>
  `wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(config.voice.deepgramModel)}` +
  `&encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&endpointing=300&smart_format=true&language=en`;

/** Open a Deepgram streaming-STT socket and wire transcripts back via callbacks. */
function openDeepgram(
  onUtterance: (text: string) => void,
  onSpeechStarted: () => void,
): WebSocket {
  const dg = new WebSocket(DG_URL(), {
    headers: { Authorization: `Token ${config.voice.deepgramApiKey}` },
  });
  dg.on('message', (raw) => {
    let evt: any;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (evt.type === 'Results') {
      const alt = evt.channel?.alternatives?.[0];
      const transcript = (alt?.transcript ?? '').trim();
      if (transcript && !evt.is_final) onSpeechStarted(); // interim speech → barge-in signal
      if (evt.is_final && evt.speech_final && transcript) onUtterance(transcript);
    }
  });
  dg.on('error', (e) => console.error('[mediaStream] Deepgram error', e));
  return dg;
}

// Common booking vocabulary + the clinic's own service names — fed to STT as
// phrase hints so domain words transcribe correctly over noisy phone audio.
const BASE_PHRASES = [
  'booking', 'appointment', 'reschedule', 'cancel', 'confirm', 'availability',
  'deposit', 'reservation', 'check in', 'check out', 'this week', 'next week',
  'morning', 'afternoon', 'tomorrow', 'consultation', 'follow up',
];
function sttPhraseHints(clinic: any): string[] {
  const services = (clinic?.services_json ?? []).map((s: any) => String(s?.service ?? '').trim()).filter(Boolean);
  return [...new Set([...services, clinic?.name, ...BASE_PHRASES].filter(Boolean))].slice(0, 80);
}

/** Stream Azure TTS μ-law 8k to Twilio — Remi's voice, per reply language. */
function azureSpeak(ctx: CallCtx, twilioWs: WebSocket, text: string, voice: string, locale: string): Promise<void> {
  ctx.botSpeaking = true;
  return new Promise<void>((resolve) => {
    const tts = azureSynthesize({
      text,
      voice,
      locale,
      onChunk: (mulaw) => {
        if (ctx.closed) return;
        twilioWs.send(JSON.stringify({ event: 'media', streamSid: ctx.streamSid, media: { payload: mulaw.toString('base64') } }));
      },
      onDone: () => {
        if (!ctx.closed) twilioWs.send(JSON.stringify({ event: 'mark', streamSid: ctx.streamSid, mark: { name: 'eos' } }));
        if (ctx.azureTts === tts) ctx.azureTts = null;
        ctx.botSpeaking = false;
        resolve();
      },
    });
    ctx.azureTts = tts;
  });
}

/** Stream ElevenLabs TTS μ-law 8k to Twilio — used for all English replies. */
async function elevenLabsSpeak(ctx: CallCtx, twilioWs: WebSocket, text: string) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.voice.elevenLabsVoiceId}/stream?output_format=ulaw_8000`;
  const abort = new AbortController();
  ctx.ttsAbort = abort;
  ctx.botSpeaking = true;
  try {
    const res = await fetch(url, {
      method: 'POST', signal: abort.signal,
      headers: { 'xi-api-key': config.voice.elevenLabsApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: config.voice.elevenLabsTtsModel, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
    });
    if (!res.ok || !res.body) { console.error('[mediaStream] ElevenLabs TTS failed', res.status); return; }
    const reader = (res.body as any).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || ctx.closed || abort.signal.aborted) break;
      if (value?.length) twilioWs.send(JSON.stringify({ event: 'media', streamSid: ctx.streamSid, media: { payload: Buffer.from(value).toString('base64') } }));
    }
    if (!ctx.closed && !abort.signal.aborted)
      twilioWs.send(JSON.stringify({ event: 'mark', streamSid: ctx.streamSid, mark: { name: 'eos' } }));
  } catch (e: any) {
    if (e?.name !== 'AbortError') console.error('[mediaStream] ElevenLabs speak error', e);
  } finally {
    if (ctx.ttsAbort === abort) ctx.ttsAbort = null;
    ctx.botSpeaking = false;
  }
}

/**
 * Route TTS by reply language (all Azure neural, spoken in-locale via SSML):
 *   English   → Ava (multilingual)   · Afrikaans → Ada (multilingual)
 *   isiZulu   → Thando (native zu-ZA)
 * ElevenLabs is only a fallback when no Azure key is configured.
 */
async function speak(ctx: CallCtx, twilioWs: WebSocket, text: string) {
  const clean = speechNormalize(text);
  if (USE_AZURE) {
    // Pick the language: trust strong reply-text signals first, but fall back to the
    // caller's STT-detected language (ctx.lang) so a short Afrikaans/isiZulu reply that
    // doesn't trip text detection still gets the right voice+locale — otherwise it'd be
    // spoken by the English voice and sound foreign/Germanic.
    const lang = detectZulu(clean) ? 'zu' : detectAfrikaans(clean) ? 'af' : ctx.lang;
    if (lang === 'zu') return azureSpeak(ctx, twilioWs, clean, config.voice.azureVoiceZu, 'zu-ZA');
    if (lang === 'af') return azureSpeak(ctx, twilioWs, clean, config.voice.azureVoiceAf, 'af-ZA');
    return azureSpeak(ctx, twilioWs, clean, config.voice.azureVoiceEn, 'en-ZA');
  }
  return elevenLabsSpeak(ctx, twilioWs, clean); // fallback only when no Azure key
}

/** Stop any in-progress TTS and flush Twilio's playback buffer (barge-in). */
function bargeIn(ctx: CallCtx, twilioWs: WebSocket) {
  if (ctx.turnAbort) ctx.turnAbort.aborted = true; // stop LLM stream + sentence queue
  if (ctx.ttsAbort) ctx.ttsAbort.abort();
  if (ctx.azureTts) { ctx.azureTts.stop(); ctx.azureTts = null; }
  if (ctx.botSpeaking && !ctx.closed) {
    twilioWs.send(JSON.stringify({ event: 'clear', streamSid: ctx.streamSid }));
  }
  ctx.botSpeaking = false;
}

export function attachMediaStream(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws/media' });

  wss.on('connection', (twilioWs: WebSocket) => {
    const ctx: CallCtx = {
      streamSid: '',
      clinic: null,
      customer: null,
      convo: { id: '' },
      isFirstTurn: false,
      dg: null,
      azureStt: null,
      azureTts: null,
      turnAbort: null,
      botSpeaking: false,
      thinking: false,
      ttsAbort: null,
      closed: false,
      lang: 'en',
    };

    // Absolute safety cap: tear the session down after MAX_CALL_MINUTES so a stuck
    // or maliciously-held-open socket can't keep billable STT/LLM running forever.
    const teardown = () => {
      if (ctx.closed) return;
      ctx.closed = true;
      if (ctx.turnAbort) ctx.turnAbort.aborted = true;
      if (ctx.ttsAbort) ctx.ttsAbort.abort();
      try { ctx.dg?.close(); } catch { /* */ }
      try { ctx.azureStt?.close(); } catch { /* */ }
      try { ctx.azureTts?.stop(); } catch { /* */ }
      try { twilioWs.close(); } catch { /* */ }
    };
    const maxCallMs = parseInt(process.env.MAX_CALL_MINUTES ?? '15', 10) * 60_000;
    const maxTimer = setTimeout(() => { console.warn('[mediaStream] max call duration reached — closing'); teardown(); }, maxCallMs);
    maxTimer.unref?.();
    twilioWs.on('close', () => clearTimeout(maxTimer));

    // Absolute cap on conversational turns per call — a second guard (alongside the
    // duration timer) against a stuck or abusive session driving unbounded LLM cost.
    const MAX_TURNS = parseInt(process.env.MAX_CALL_TURNS ?? '40', 10);
    let turnCount = 0;

    const handleUtterance = async (text: string) => {
      if (ctx.thinking || ctx.closed) return; // one turn at a time
      if (++turnCount > MAX_TURNS) {
        console.warn('[mediaStream] max turns reached — closing');
        teardown();
        return;
      }
      ctx.thinking = true;
      const abort = { aborted: false };
      ctx.turnAbort = abort;

      // Speak streamed sentences strictly in order: one at a time, as they arrive.
      // Latency breakdown (→ Railway logs) so we can see where the seconds go:
      // db = saveMessage+getHistory, brain = LLM time to first spoken sentence.
      const t0 = Date.now();
      let firstAudio = false;
      const queue: string[] = [];
      let pumping = false;
      const pump = async () => {
        if (pumping) return;
        pumping = true;
        while (queue.length && !ctx.closed && !abort.aborted) {
          if (!firstAudio) { firstAudio = true; console.log(`[lat] first audio out +${Date.now() - t0}ms`); }
          await speak(ctx, twilioWs, queue.shift()!);
        }
        pumping = false;
      };

      try {
        await saveMessage(ctx.convo.id, 'in', text);
        const history = await getHistory(ctx.convo.id);
        console.log(`[lat] db (save+history) +${Date.now() - t0}ms`);
        let firstSentence = false;
        const reply = await runAgentStream(
          ctx.clinic, ctx.customer, ctx.convo, history, ctx.isFirstTurn, true,
          (sentence) => {
            if (!firstSentence) { firstSentence = true; console.log(`[lat] brain first sentence +${Date.now() - t0}ms`); }
            if (!abort.aborted && !ctx.closed) { queue.push(sentence); void pump(); }
          },
          abort,
        );
        ctx.isFirstTurn = false;
        if (reply && !abort.aborted) await saveMessage(ctx.convo.id, 'out', reply);
        // Wait for the queued sentences to finish before ending the turn.
        while ((queue.length || pumping) && !ctx.closed && !abort.aborted) await sleep(50);
        console.log(`[lat] turn complete +${Date.now() - t0}ms`);
      } catch (e) {
        console.error('[mediaStream] turn error', e);
        if (!ctx.closed && !abort.aborted) await speak(ctx, twilioWs, 'Sorry, could you say that again?');
      } finally {
        if (ctx.turnAbort === abort) ctx.turnAbort = null;
        ctx.thinking = false;
      }
    };

    twilioWs.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.event) {
        case 'start': {
          ctx.streamSid = msg.start?.streamSid ?? msg.streamSid ?? '';
          const params = msg.start?.customParameters ?? {};
          // Auth gate: the params must carry a valid, unexpired HMAC token that this
          // server minted in the TwiML. Without it the socket is just a stranger.
          if (!verifyMediaToken(params)) {
            console.warn('[mediaStream] rejected unauthenticated/expired stream connection');
            teardown();
            break;
          }
          try {
            const clinic = await getClinic(params.clinicId);
            if (!clinic) { console.error('[mediaStream] unknown clinic in start frame'); teardown(); break; }
            const { client: customer, isNew } = await getOrCreateClient(clinic.id, params.from || '');
            const convo = await getOrCreateConversation(clinic.id, customer.id);
            ctx.clinic = clinic;
            ctx.customer = customer;
            ctx.convo = convo;
            ctx.isFirstTurn = isNew;
          } catch (e) {
            console.error('[mediaStream] start/setup error', e);
            teardown();
            break;
          }
          const greeting = `Thanks for calling ${ctx.clinic?.name ?? 'the clinic'}. I'm Remi, the virtual assistant. How can I help you today?`;
          if (USE_AZURE) {
            // Azure STT auto-detects en-ZA/af-ZA/zu-ZA; barge-in on interim, turn on final.
            // Prefix the detected language so the brain knows which to mirror.
            ctx.azureStt = createAzureRecognizer({
              onInterim: () => bargeIn(ctx, twilioWs),
              onFinal: (utterance, lang) => {
                const isZu = lang.startsWith('zu') || detectZulu(utterance);
                const isAf = !isZu && (lang.startsWith('af') || detectAfrikaans(utterance));
                ctx.lang = isZu ? 'zu' : isAf ? 'af' : 'en'; // remember for TTS voice selection
                const tag = isZu ? '[Caller is speaking isiZulu] ' : isAf ? '[Caller is speaking Afrikaans] ' : '';
                void handleUtterance(`${tag}${utterance}`).catch((e) => console.error('[mediaStream] utterance error', e));
              },
            }, sttPhraseHints(ctx.clinic));
            void speak(ctx, twilioWs, greeting).catch((e) => console.error('[mediaStream] greeting error', e));
          } else {
            // Fallback: Deepgram STT (English).
            ctx.dg = openDeepgram(
              (utterance) => void handleUtterance(utterance).catch((e) => console.error('[mediaStream] utterance error', e)),
              () => bargeIn(ctx, twilioWs),
            );
            const greet = () => void speak(ctx, twilioWs, greeting).catch((e) => console.error('[mediaStream] greeting error', e));
            if (ctx.dg.readyState === WebSocket.OPEN) greet();
            else ctx.dg.on('open', greet);
          }
          break;
        }
        case 'media': {
          // Forward caller audio (base64 μ-law) to the active STT.
          const payload = msg.media?.payload;
          if (!payload) break;
          if (USE_AZURE) {
            if (ctx.azureStt) ctx.azureStt.write(Buffer.from(payload, 'base64'));
          } else if (ctx.dg && ctx.dg.readyState === WebSocket.OPEN) {
            ctx.dg.send(Buffer.from(payload, 'base64'));
          }
          break;
        }
        case 'mark':
          // Playback of a TTS utterance finished.
          ctx.botSpeaking = false;
          break;
        case 'stop':
          teardown(); // single cleanup path — stops STT/TTS, aborts the turn, closes the socket
          break;
      }
    });

    twilioWs.on('close', teardown);
  });

  console.log('[mediaStream] Media Streams WebSocket attached at /ws/media');
}
