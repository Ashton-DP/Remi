import { config } from '../config';
import { runClaudeAgent } from './claudeAgent';
import { runGeminiAgent } from './geminiAgent';

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
  if (config.aiProvider === 'claude') {
    return runClaudeAgent(clinic, customer, convo, history, isFirstContact, isVoice);
  }
  return runGeminiAgent(clinic, customer, convo, history, isFirstContact, isVoice);
}
