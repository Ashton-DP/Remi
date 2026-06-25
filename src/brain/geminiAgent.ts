import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { tools } from './tools';
import { buildSystemPrompt } from './systemPrompt';
import { executeTool } from './executeTool';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const MAX_TURNS = 6;

// Map our (Anthropic-style, JSON-schema) tool definitions to Gemini's format.
const TYPE_MAP: Record<string, string> = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'NUMBER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
};

function convSchema(schema: any): any {
  const out: any = { type: TYPE_MAP[schema?.type] ?? 'STRING' };
  if (schema?.description) out.description = schema.description;
  if (schema?.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = convSchema(v);
  }
  if (schema?.required) out.required = schema.required;
  if (schema?.items) out.items = convSchema(schema.items);
  return out;
}

const geminiTools = [
  {
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: convSchema(t.input_schema),
    })),
  },
];

/** Gemini implementation of the booking brain (function-calling loop). */
export async function runGeminiAgent(
  clinic: any,
  customer: any,
  convo: any,
  history: any[],
  isFirstContact: boolean,
  isVoice = false,
): Promise<string> {
  const systemInstruction = buildSystemPrompt(clinic, isFirstContact, isVoice);
  const contents: any[] = history.map((m: any) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await ai.models.generateContent({
      model: config.gemini.model,
      contents,
      config: { systemInstruction, tools: geminiTools },
    });

    const calls = result.functionCalls;
    if (calls && calls.length > 0) {
      contents.push({ role: 'model', parts: calls.map((fc: any) => ({ functionCall: fc })) });
      const respParts: any[] = [];
      for (const fc of calls) {
        let out: unknown;
        try {
          out = await executeTool(clinic, customer, convo, fc.name as string, fc.args ?? {});
        } catch (e) {
          out = { error: String(e) };
        }
        respParts.push({
          functionResponse: { name: fc.name, id: fc.id, response: { result: out } },
        });
      }
      contents.push({ role: 'user', parts: respParts });
      continue;
    }

    const text = (result.text ?? '').trim();
    return text || 'Sorry, could you rephrase that?';
  }

  return "Let me get one of our team to help you with that — they'll be in touch shortly.";
}

/**
 * Streaming variant for voice: same function-calling loop, but on the final
 * text turn it streams tokens and emits complete sentences via `onSentence` as
 * soon as each is ready — so TTS can start speaking before the full reply is
 * generated. Returns the full reply text. `signal.aborted` stops it (barge-in).
 */
export async function runGeminiAgentStream(
  clinic: any,
  customer: any,
  convo: any,
  history: any[],
  isFirstContact: boolean,
  isVoice: boolean,
  onSentence: (sentence: string) => void,
  signal?: { aborted: boolean },
): Promise<string> {
  const systemInstruction = buildSystemPrompt(clinic, isFirstContact, isVoice);
  const contents: any[] = history.map((m: any) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) return '';
    const stream = await ai.models.generateContentStream({
      model: config.gemini.model,
      contents,
      // Disable "thinking" on voice turns — it adds seconds of latency per call
      // and isn't needed for a receptionist's short replies.
      config: { systemInstruction, tools: geminiTools, thinkingConfig: { thinkingBudget: 0 } },
    });

    const calls: any[] = [];
    let buffer = '';   // text not yet emitted as a sentence
    let full = '';
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      const fcs = (chunk as any).functionCalls;
      if (fcs && fcs.length) calls.push(...fcs);
      const t = fcs && fcs.length ? '' : (chunk.text ?? ''); // avoid .text warning on tool-call chunks
      if (!t) continue;
      buffer += t; full += t;
      // Flush each complete sentence (ends with . ! ? … followed by whitespace).
      let m: RegExpMatchArray | null;
      while ((m = buffer.match(/^([\s\S]*?[.!?…])\s+/))) {
        const sentence = m[1].trim();
        if (sentence) onSentence(sentence);
        buffer = buffer.slice(m[0].length);
      }
    }
    if (signal?.aborted) return full.trim();

    if (calls.length > 0) {
      contents.push({ role: 'model', parts: calls.map((fc: any) => ({ functionCall: fc })) });
      const respParts: any[] = [];
      for (const fc of calls) {
        let out: unknown;
        try { out = await executeTool(clinic, customer, convo, fc.name as string, fc.args ?? {}); }
        catch (e) { out = { error: String(e) }; }
        respParts.push({ functionResponse: { name: fc.name, id: fc.id, response: { result: out } } });
      }
      contents.push({ role: 'user', parts: respParts });
      continue;
    }

    const rest = buffer.trim();
    if (rest) onSentence(rest);
    const final = full.trim();
    if (final) return final;
    onSentence('Sorry, could you rephrase that?');
    return 'Sorry, could you rephrase that?';
  }

  const fb = "Let me get one of our team to help you with that — they'll be in touch shortly.";
  onSentence(fb);
  return fb;
}
