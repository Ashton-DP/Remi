/**
 * Staff brain — runs when an inbound message is from a recognised staff member.
 * A focused Gemini function-calling loop (mirrors geminiAgent) with the staff
 * tools + a colleague persona. Kept separate from the client booking brain so
 * the two never mix: staff get clock-in/out/leave, clients get bookings.
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { staffTools } from './staffTools';
import { executeStaffTool } from './staffExecute';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const MAX_TURNS = 5;

const TYPE_MAP: Record<string, string> = {
  object: 'OBJECT', string: 'STRING', number: 'NUMBER', integer: 'NUMBER', boolean: 'BOOLEAN', array: 'ARRAY',
};
function convSchema(s: any): any {
  const out: any = { type: TYPE_MAP[s?.type] ?? 'STRING' };
  if (s?.description) out.description = s.description;
  if (s?.properties) { out.properties = {}; for (const [k, v] of Object.entries(s.properties)) out.properties[k] = convSchema(v); }
  if (s?.required) out.required = s.required;
  if (s?.items) out.items = convSchema(s.items);
  return out;
}
const geminiStaffTools = [{
  functionDeclarations: staffTools.map((t) => ({ name: t.name, description: t.description, parameters: convSchema(t.input_schema) })),
}];

function staffSystemPrompt(clinic: any, staff: any): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Remi, the staff assistant for ${clinic.name}. You are talking to ${staff.name}, a team member (role: ${staff.role}). Today is ${today}.

You help staff with work admin over WhatsApp: clocking in and out, checking their hours this week, submitting time-off / leave requests for the owner to approve, adding office to-dos/reminders, and logging business expenses.

Tone: warm, brief, like a helpful colleague. Use the person's name occasionally. Mirror their language (English/Afrikaans).

Rules:
- For clock in/out, hours, or leave, CALL THE MATCHING TOOL — never guess or claim you did it without the tool.
- For leave, work out the exact dates (resolve "next Friday", "the 15th", "Mon to Wed") into YYYY-MM-DD before calling request_leave. If a single day, use the same date for start and end. Confirm the dates back to them in your reply.
- You ONLY handle staff work admin. If they ask about booking a client, prices, or patient matters, tell them that's handled on the client line and you're just here for their work admin.
- Never share other staff members' hours or leave.`;
}

/** Run the staff brain. `history` is [{role, content}] including the latest turn. */
export async function runStaffAgent(clinic: any, staff: any, history: any[]): Promise<string> {
  const systemInstruction = staffSystemPrompt(clinic, staff);
  const contents: any[] = history.map((m: any) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await ai.models.generateContent({
      model: config.gemini.model,
      contents,
      config: { systemInstruction, tools: geminiStaffTools },
    });

    const calls = result.functionCalls;
    if (calls && calls.length > 0) {
      contents.push({ role: 'model', parts: calls.map((fc: any) => ({ functionCall: fc })) });
      const respParts: any[] = [];
      for (const fc of calls) {
        let out: unknown;
        try { out = await executeStaffTool(clinic, staff, fc.name as string, fc.args ?? {}); }
        catch (e) { out = { error: String(e) }; }
        respParts.push({ functionResponse: { name: fc.name, id: fc.id, response: { result: out } } });
      }
      contents.push({ role: 'user', parts: respParts });
      continue;
    }

    const text = (result.text ?? '').trim();
    return text || "Sorry, I didn't catch that — did you want to clock in, clock out, check your hours, or request leave?";
  }
  return 'Let me get the owner to help you with that directly.';
}
