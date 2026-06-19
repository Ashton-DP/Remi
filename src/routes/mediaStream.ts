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
import { speechNormalize, xmlEscape } from './voiceRelay';

/**
 * Custom voice pipeline using Twilio Media Streams (raw audio) + our OWN providers:
 *   caller audio → Deepgram (streaming STT) → Gemini (runAgent) → ElevenLabs (TTS, μ-law 8k) → caller
 * Gives full control: any ElevenLabs voice + barge-in. Heavier than ConversationRelay.
 *
 * Gated behind VOICE_MODE=mediastream.
 */

/** TwiML that streams the call's raw audio to our /ws/media WebSocket. */
export function buildMediaStreamTwiml(clinic: any, from: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${xmlEscape(config.voice.mediaWsUrl)}">`,
    `      <Parameter name="clinicId" value="${xmlEscape(clinic?.id ?? '')}"/>`,
    `      <Parameter name="from" value="${xmlEscape(from)}"/>`,
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
  dg: WebSocket | null; // Deepgram STT socket
  botSpeaking: boolean;
  thinking: boolean;
  ttsAbort: AbortController | null;
  closed: boolean;
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

/** Stream ElevenLabs TTS (μ-law 8k) for `text` straight to the Twilio socket. */
async function speak(ctx: CallCtx, twilioWs: WebSocket, text: string) {
  const clean = speechNormalize(text);
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${config.voice.elevenLabsVoiceId}/stream` +
    `?output_format=ulaw_8000`;
  const abort = new AbortController();
  ctx.ttsAbort = abort;
  ctx.botSpeaking = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'xi-api-key': config.voice.elevenLabsApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: clean,
        model_id: config.voice.elevenLabsTtsModel,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    });
    if (!res.ok || !res.body) {
      console.error('[mediaStream] ElevenLabs TTS failed', res.status, await res.text().catch(() => ''));
      return;
    }
    // Stream audio chunks → Twilio media messages (base64 μ-law).
    const reader = (res.body as any).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || ctx.closed || abort.signal.aborted) break;
      if (value && value.length) {
        twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid: ctx.streamSid,
            media: { payload: Buffer.from(value).toString('base64') },
          }),
        );
      }
    }
    // Mark end of this utterance so we can detect playback completion.
    if (!ctx.closed && !abort.signal.aborted) {
      twilioWs.send(
        JSON.stringify({ event: 'mark', streamSid: ctx.streamSid, mark: { name: 'eos' } }),
      );
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') console.error('[mediaStream] speak error', e);
  } finally {
    if (ctx.ttsAbort === abort) ctx.ttsAbort = null;
    ctx.botSpeaking = false;
  }
}

/** Stop any in-progress TTS and flush Twilio's playback buffer (barge-in). */
function bargeIn(ctx: CallCtx, twilioWs: WebSocket) {
  if (ctx.ttsAbort) ctx.ttsAbort.abort();
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
      botSpeaking: false,
      thinking: false,
      ttsAbort: null,
      closed: false,
    };

    const handleUtterance = async (text: string) => {
      if (ctx.thinking || ctx.closed) return; // one turn at a time
      ctx.thinking = true;
      try {
        await saveMessage(ctx.convo.id, 'in', text);
        const history = await getHistory(ctx.convo.id);
        const reply = await runAgent(ctx.clinic, ctx.customer, ctx.convo, history, ctx.isFirstTurn, true);
        ctx.isFirstTurn = false;
        await saveMessage(ctx.convo.id, 'out', reply);
        if (!ctx.closed) await speak(ctx, twilioWs, reply);
      } catch (e) {
        console.error('[mediaStream] turn error', e);
        if (!ctx.closed) await speak(ctx, twilioWs, "Sorry, could you say that again?");
      } finally {
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
          try {
            const clinic = await getClinic(params.clinicId || config.defaultClinicId);
            const { client: customer, isNew } = await getOrCreateClient(clinic.id, params.from || '');
            const convo = await getOrCreateConversation(clinic.id, customer.id);
            ctx.clinic = clinic;
            ctx.customer = customer;
            ctx.convo = convo;
            ctx.isFirstTurn = isNew;
          } catch (e) {
            console.error('[mediaStream] start/setup error', e);
          }
          // Open Deepgram; barge-in on interim speech, run a turn on final utterance.
          ctx.dg = openDeepgram(
            (utterance) => handleUtterance(utterance),
            () => bargeIn(ctx, twilioWs),
          );
          // Greet the caller once the socket is ready.
          const greet = () =>
            speak(
              ctx,
              twilioWs,
              `Thanks for calling ${ctx.clinic?.name ?? 'the clinic'}. I'm Remi, the virtual assistant. How can I help you today?`,
            );
          if (ctx.dg.readyState === WebSocket.OPEN) greet();
          else ctx.dg.on('open', greet);
          break;
        }
        case 'media': {
          // Forward caller audio (base64 μ-law) to Deepgram.
          const payload = msg.media?.payload;
          if (payload && ctx.dg && ctx.dg.readyState === WebSocket.OPEN) {
            ctx.dg.send(Buffer.from(payload, 'base64'));
          }
          break;
        }
        case 'mark':
          // Playback of a TTS utterance finished.
          ctx.botSpeaking = false;
          break;
        case 'stop':
          ctx.closed = true;
          if (ctx.dg) try { ctx.dg.close(); } catch {}
          break;
      }
    });

    twilioWs.on('close', () => {
      ctx.closed = true;
      if (ctx.ttsAbort) ctx.ttsAbort.abort();
      if (ctx.dg) try { ctx.dg.close(); } catch {}
    });
  });

  console.log('[mediaStream] Media Streams WebSocket attached at /ws/media');
}
