import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { tools } from './tools';
import { buildSystemPrompt } from './systemPrompt';
import { executeTool } from './executeTool';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TURNS = 6;

/** Claude implementation of the booking brain (manual tool-use loop). */
export async function runClaudeAgent(
  clinic: any,
  customer: any,
  convo: any,
  history: any[],
  isFirstContact: boolean,
  isVoice = false,
): Promise<string> {
  const system = buildSystemPrompt(clinic, isFirstContact, isVoice);
  const messages: any[] = [...history];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.messages.create({
      model: config.model,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const results: any[] = [];
      for (const block of resp.content as any[]) {
        if (block.type === 'tool_use') {
          let out: unknown;
          try {
            out = await executeTool(clinic, customer, convo, block.name, block.input);
          } catch (e) {
            out = { error: String(e) };
          }
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(out),
          });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    const text = (resp.content as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || 'Sorry, could you rephrase that?';
  }

  return "Let me get one of our team to help you with that — they'll be in touch shortly.";
}
