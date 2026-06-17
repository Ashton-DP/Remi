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
): Promise<string> {
  const systemInstruction = buildSystemPrompt(clinic, isFirstContact);
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
