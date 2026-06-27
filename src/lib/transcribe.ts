import { GoogleGenAI } from '@google/genai';
import { config } from '../config';

/**
 * Transcribe an inbound WhatsApp/Twilio audio note to text.
 *
 * Uses Gemini's multimodal audio support (same SDK + key as the booking brain),
 * so there's no extra dependency and no audio transcoding. Handles English and
 * Afrikaans (and code-switching). Returns '' on any failure so callers can fall
 * back to a "please type your message" reply instead of dead-ending.
 *
 * WhatsApp voice notes arrive as audio/ogg (Opus), which Gemini accepts directly.
 */
export async function transcribeTwilioAudio(mediaUrl: string, contentType: string): Promise<string> {
  if (!mediaUrl || !config.gemini.apiKey) return '';
  try {
    // Twilio media URLs require Basic auth (Account SID : Auth Token). Twilio
    // 307-redirects to the actual media host; fetch follows it and strips the
    // Authorization header on the cross-origin hop (per the fetch spec), so the
    // signed media URL serves the bytes without auth.
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const res = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      console.error('[transcribe] media fetch failed', res.status, res.statusText);
      return '';
    }
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    const mimeType = (contentType || 'audio/ogg').split(';')[0].trim();

    const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    const result: any = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          {
            text:
              'Transcribe this voice note verbatim. It may be in English or Afrikaans, or a mix. ' +
              'Return ONLY the exact words spoken — no quotes, no speaker labels, no commentary, no translation. ' +
              'If there is no intelligible speech, return an empty string.',
          },
        ],
      }],
    });

    return (result.text ?? '').trim();
  } catch (e) {
    console.error('[transcribe] error', e);
    return '';
  }
}
