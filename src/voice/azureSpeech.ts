import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { config } from '../config';

/**
 * Azure Speech helpers for the Twilio Media Streams voice pipeline.
 *
 * Twilio sends/expects 8 kHz μ-law (G.711) mono. Azure STT wants linear PCM, so
 * we decode μ-law → PCM16 on the way in; Azure TTS can emit μ-law directly, so
 * the way out needs no transcoding.
 *
 * STT auto-detects across config.voice.azureSttLanguages (en-ZA + af-ZA + zu-ZA)
 * to handle code-switching. TTS voice is chosen per reply language (English via
 * ElevenLabs; Afrikaans + isiZulu via Azure neural voices).
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

// Distinctive isiZulu tokens + agglutinative prefixes. Used on the REPLY text so
// the spoken voice matches what the brain actually said (it mirrors the caller).
const ZU_TOKENS = [
  'sawubona', 'sanibonani', 'yebo', 'cha', 'ngicela', 'ngiyabonga', 'ngiyafuna',
  'ngifuna', 'unjani', 'ngingakwazi', 'ukubhuka', 'usuku', 'kahle', 'kodwa',
  'futhi', 'ngoba', 'malini', 'isikhathi', 'namhlanje', 'kusasa', 'siza', 'uma',
  'wena', 'mina', 'khona', 'lapha', 'manje', 'ngi', 'uku', 'nje', 'ngokushesha',
];
const ZU_PREFIXES = ['ngi', 'uku', 'isi', 'aba', 'umu', 'izi', 'ama', 'esi', 'nga'];
export function detectZulu(text: string): boolean {
  const words = (text || '').toLowerCase().match(/[a-z']+/g) ?? [];
  if (!words.length) return false;
  let hits = 0;
  for (const w of words) {
    if (ZU_TOKENS.includes(w)) { hits += 1.5; continue; }
    // Bantu digraphs / agglutinative prefixes that are vanishingly rare in en/af.
    if (w.length >= 4 && ZU_PREFIXES.some((p) => w.startsWith(p))) hits++;
    if (/(hl|ngc|dl|hh|nj|zw|ntsh)/.test(w)) hits += 0.5;
  }
  return hits >= 2 || hits / words.length >= 0.3;
}

/** Azure TTS voice for Afrikaans replies. English goes through ElevenLabs. */
export function afrikaaansTtsVoice(): string {
  return config.voice.azureVoiceAf;
}

/** Azure TTS voice for isiZulu replies. */
export function zuluTtsVoice(): string {
  return config.voice.azureVoiceZu;
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
}, phrases: string[] = []): AzureRecognizer {
  // Azure keys are region-bound. Use a dedicated STT key+region if provided
  // (westeurope/eastus → full en/af/zu continuous language-ID); otherwise fall back
  // to the main key+region so a single SA key still works (English-primary STT).
  const sttKey = config.voice.azureSttKey || config.voice.azureSpeechKey;
  const sttRegion = config.voice.azureSttKey ? config.voice.azureSttRegion : config.voice.azureSpeechRegion;
  const speechConfig = sdk.SpeechConfig.fromSubscription(sttKey, sttRegion);
  // AT-START language-ID: identify the language ONCE from the opening audio and keep
  // it for the whole call. Continuous mode re-decides every utterance, which flaps
  // wildly across the 3 acoustically-similar SA languages (English heard as Zulu,
  // etc.). Callers almost never change language mid-call, so one stable decision is
  // far more reliable than constant re-detection.
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, 'AtStart');
  // Finalise the caller's turn faster after they stop speaking (lower latency).
  speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(config.voice.azureSttSilenceMs));
  const autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(config.voice.azureSttLanguages);

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);

  // Phrase hints — bias the recogniser toward this clinic's own vocabulary
  // (service/treatment names, common booking words) so domain terms transcribe
  // correctly instead of being mangled into similar-sounding everyday words.
  if (phrases.length) {
    const pl = sdk.PhraseListGrammar.fromRecognizer(recognizer);
    for (const p of phrases) { const t = String(p ?? '').trim(); if (t) pl.addPhrase(t); }
  }

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
  locale?: string;       // when set, speak via SSML in this language — needed so a
                         // multilingual voice (e.g. Ada) reliably speaks Afrikaans.
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
  const ok = () => finish();
  const fail = (err: any) => { console.error('[azure] TTS error:', err); finish(); };
  if (opts.locale) {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${opts.locale}"><voice name="${opts.voice}">${esc(opts.text)}</voice></speak>`;
    synthesizer.speakSsmlAsync(ssml, ok, fail);
  } else {
    synthesizer.speakTextAsync(opts.text, ok, fail);
  }

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
