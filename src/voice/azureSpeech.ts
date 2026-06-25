import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { config } from '../config';

/**
 * Azure Speech helpers for the Twilio Media Streams voice pipeline.
 *
 * Twilio sends/expects 8 kHz μ-law (G.711) mono. Azure STT wants linear PCM, so
 * we decode μ-law → PCM16 on the way in; Azure TTS can emit μ-law directly, so
 * the way out needs no transcoding.
 *
 * STT auto-detects across config.voice.azureSttLanguages (e.g. af-ZA + en-ZA) to
 * handle Afrikaans/English code-switching. TTS voice is chosen per reply language.
 */

// ── μ-law (G.711) → PCM16 ─────────────────────────────────────────────────────
const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    let s = ((u & 0x0f) << 3) + 0x84;
    s <<= (u & 0x70) >> 4;
    t[i] = (u & 0x80) ? (0x84 - s) : (s - 0x84);
  }
  return t;
})();

/** Decode a μ-law buffer (1 byte/sample) to little-endian PCM16 (2 bytes/sample). */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) out.writeInt16LE(MULAW_TABLE[mulaw[i]], i * 2);
  return out;
}

// ── Reply-language detection (to pick the TTS voice) ──────────────────────────
// Distinctive Afrikaans tokens. Used on the REPLY text so the spoken voice
// matches what's actually said (the brain mirrors the caller's language).
const AF_TOKENS = [
  'ek', 'jy', 'jou', 'nie', 'het', 'die', 'en', 'is', 'vir', 'wil', 'graag',
  'asseblief', 'dankie', 'goeie', 'môre', 'more', 'kan', 'sal', 'ons', 'hierdie',
  'maak', 'afspraak', 'help', 'baie', 'ja', 'nee', 'wat', 'hoe', 'wanneer',
];
export function detectAfrikaans(text: string): boolean {
  const words = (text || '').toLowerCase().match(/[a-zà-ÿ']+/g) ?? [];
  if (!words.length) return false;
  let hits = 0;
  for (const w of words) if (AF_TOKENS.includes(w) || w.includes("'n")) hits++;
  // Afrikaans if a meaningful share of words are distinctively Afrikaans.
  return hits >= 2 || hits / words.length >= 0.25;
}

/** Azure TTS voice for Afrikaans replies. English goes through ElevenLabs. */
export function afrikaaansTtsVoice(): string {
  return config.voice.azureVoiceAf;
}

// ── STT: continuous recognition with language auto-detect ─────────────────────
export interface AzureRecognizer {
  /** Feed a μ-law audio chunk from Twilio. */
  write(mulaw: Buffer): void;
  close(): void;
}

export function createAzureRecognizer(handlers: {
  onInterim: () => void;
  onFinal: (text: string, language: string) => void;
}): AzureRecognizer {
  // STT uses azureSttRegion (westeurope/eastus) — southafricanorth does NOT support
  // af-ZA continuous language ID and silently falls back to English-only recognition.
  const speechConfig = sdk.SpeechConfig.fromSubscription(config.voice.azureSpeechKey, config.voice.azureSttRegion);
  // Continuous language-ID so it keeps detecting af-ZA vs en-ZA throughout the
  // call (the default "at-start" mode fails to switch on code-switching).
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
  // Finalise the caller's turn faster after they stop speaking (lower latency).
  speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(config.voice.azureSttSilenceMs));
  const autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(config.voice.azureSttLanguages);

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);

  recognizer.recognizing = (_s, e) => {
    if ((e.result?.text ?? '').trim()) handlers.onInterim(); // caller talking → barge-in
  };
  recognizer.recognized = (_s, e) => {
    if (e.result?.reason !== sdk.ResultReason.RecognizedSpeech) return;
    const text = (e.result.text ?? '').trim();
    if (!text) return;
    let language = '';
    try { language = sdk.AutoDetectSourceLanguageResult.fromResult(e.result).language ?? ''; } catch { /* ignore */ }
    handlers.onFinal(text, language);
  };
  recognizer.canceled = (_s, e) => console.error('[azure] STT canceled:', e.errorDetails ?? e.reason);

  recognizer.startContinuousRecognitionAsync(undefined, (err) => console.error('[azure] STT start failed:', err));

  let closed = false;
  return {
    write(mulaw: Buffer) {
      if (closed) return;
      const pcm = mulawToPcm16(mulaw);
      // Azure wants an ArrayBuffer slice of exactly this chunk.
      pushStream.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
    },
    close() {
      if (closed) return;
      closed = true;
      try { recognizer.stopContinuousRecognitionAsync(() => { try { recognizer.close(); } catch { /* */ } }); } catch { /* */ }
      try { pushStream.close(); } catch { /* */ }
    },
  };
}

// ── TTS: synthesize a reply to μ-law 8k, streaming chunks out ──────────────────
export interface AzureSynthesis { stop(): void; }

/**
 * Synthesize `text` in `voice` to μ-law 8k, forwarding audio chunks to onChunk as
 * they arrive (low latency). Calls onDone when finished. stop() aborts (barge-in).
 */
export function azureSynthesize(opts: {
  text: string;
  voice: string;
  onChunk: (mulaw: Buffer) => void;
  onDone: () => void;
}): AzureSynthesis {
  const speechConfig = sdk.SpeechConfig.fromSubscription(config.voice.azureSpeechKey, config.voice.azureSpeechRegion);
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;
  speechConfig.speechSynthesisVoiceName = opts.voice;

  let stopped = false;
  const pushOut = sdk.PushAudioOutputStream.create({
    write(dataBuffer: ArrayBuffer): number {
      if (!stopped && dataBuffer.byteLength) opts.onChunk(Buffer.from(new Uint8Array(dataBuffer)));
      return dataBuffer.byteLength;
    },
    close() { /* no-op */ },
  });
  const audioConfig = sdk.AudioConfig.fromStreamOutput(pushOut);
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

  const finish = () => { try { synthesizer.close(); } catch { /* */ } opts.onDone(); };
  synthesizer.speakTextAsync(
    opts.text,
    () => finish(),
    (err) => { console.error('[azure] TTS error:', err); finish(); },
  );

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { synthesizer.close(); } catch { /* */ }
    },
  };
}

/** Whether Azure Speech is configured (key present). */
export function azureSpeechEnabled(): boolean {
  return Boolean(config.voice.azureSpeechKey);
}
