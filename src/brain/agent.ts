import { config } from '../config';
import { runClaudeAgent } from './claudeAgent';
import { runGeminiAgent, runGeminiAgentStream } from './geminiAgent';
import { createEscalation } from '../db';

/** Warm hand-off shown when the AI provider fails, so we never dead-end a lead. */
export function aiFallbackMessage(isVoice: boolean): string {
  return isVoice
    ? "I'm sorry, I'm having a little trouble right now. Let me have a team member call you straight back."
    : "Sorry — I'm having a bit of trouble right now. I've let the team know and someone will message you back shortly. 🙏";
}

/**
 * Run the booking brain using the configured provider (AI_PROVIDER).
 * `history` is the conversation so far in {role, content} form, including the
 * latest user turn. Returns the reply to send back over WhatsApp.
 */
export async function runAgent(
  clinic: any,
  customer: any,
  convo: any,
  history: any[],
  isFirstContact: boolean,
  isVoice = false,
): Promise<string> {
  try {
    if (config.aiProvider === 'claude') {
      return await runClaudeAgent(clinic, customer, convo, history, isFirstContact, isVoice);
    }
    return await runGeminiAgent(clinic, customer, convo, history, isFirstContact, isVoice);
  } catch (e) {
    // AI provider errored or rate-limited. Don't drop the lead: flag a human and
    // give the customer a warm hand-off instead of a dead end.
    console.error('[agent] AI provider failed — escalating to human', e);
    try {
      await createEscalation(
        convo.id,
        'ai_error',
        `AI provider (${config.aiProvider}) failed: ${(e as Error)?.message ?? 'unknown error'}`,
      );
    } catch (esc) {
      console.error('[agent] escalation also failed', esc);
    }
    return aiFallbackMessage(isVoice);
  }
}

/**
 * Streaming version for voice. Emits complete sentences via `onSentence` as the
 * reply is generated (so TTS can start speaking sooner), and returns the full
 * reply. Claude has no streaming path here, so it falls back to one whole
 * "sentence". `signal.aborted` stops generation (barge-in).
 */
export async function runAgentStream(
  clinic: any,
  customer: any,
  convo: any,
  history: any[],
  isFirstContact: boolean,
  isVoice: boolean,
  onSentence: (sentence: string) => void,
  signal?: { aborted: boolean },
): Promise<string> {
  try {
    if (config.aiProvider === 'claude') {
      const full = await runClaudeAgent(clinic, customer, convo, history, isFirstContact, isVoice);
      if (!signal?.aborted && full) onSentence(full);
      return full;
    }
    return await runGeminiAgentStream(clinic, customer, convo, history, isFirstContact, isVoice, onSentence, signal);
  } catch (e) {
    console.error('[agent] AI provider failed (stream) — escalating to human', e);
    try {
      await createEscalation(convo.id, 'ai_error', `AI provider (${config.aiProvider}) failed: ${(e as Error)?.message ?? 'unknown error'}`);
    } catch (esc) {
      console.error('[agent] escalation also failed', esc);
    }
    const fb = aiFallbackMessage(isVoice);
    if (!signal?.aborted) onSentence(fb);
    return fb;
  }
}
