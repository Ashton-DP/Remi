/**
 * Remi copilot — the staff-facing AI the office manager talks to. It briefs them
 * on the day, answers questions from live clinic data, and takes safe, reversible
 * internal actions on request. Outward-facing actions (messaging a customer) are
 * deliberately NOT available — those stay human-confirmed.
 *
 * This is the first slice of the operator-OS direction.
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { roleAtLeast } from '../lib/apiAuth';
import {
  getTodaysBookings, listClinicBookings, getChaseableInvoices, getOpenEscalations,
  listConversations, getReportData, countConversations,
  getInvoiceByNumber, setChasingPaused, resolveEscalation,
  snoozeInvoice, markInvoicePaidById,
} from '../db';
import { computeReportStats } from '../report';
import { computeInsights } from '../dashboard';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const MAX_TURNS = 8;

type Tool = { name: string; description: string; input_schema: any };
const tools: Tool[] = [
  { name: 'get_day_brief', description: "Today's appointments, recent cancellations, overdue-invoice summary and open items needing the manager. Use this to brief the manager.", input_schema: { type: 'object', properties: {} } },
  { name: 'list_overdue_invoices', description: 'List overdue invoices Remi is chasing (number, customer, amount, due date, chase stage).', input_schema: { type: 'object', properties: {} } },
  { name: 'list_bookings', description: 'Recent and upcoming appointments.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_conversations', description: 'Recent customer conversations Remi handled.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_insights', description: 'Last-30-day performance: revenue captured/recovered, bookings, conversion, no-show rate, top service, busiest day.', input_schema: { type: 'object', properties: {} } },
  { name: 'pause_chasing', description: 'Pause all invoice chasing for the clinic (kill switch).', input_schema: { type: 'object', properties: {} } },
  { name: 'resume_chasing', description: 'Resume invoice chasing for the clinic.', input_schema: { type: 'object', properties: {} } },
  { name: 'snooze_invoice', description: 'Hold off chasing one invoice for a number of days.', input_schema: { type: 'object', properties: { invoice_number: { type: 'string' }, days: { type: 'number', description: 'default 5' } }, required: ['invoice_number'] } },
  { name: 'mark_invoice_paid', description: 'Mark one invoice as paid (stops chasing it).', input_schema: { type: 'object', properties: { invoice_number: { type: 'string' } }, required: ['invoice_number'] } },
  { name: 'resolve_escalation', description: 'Mark an escalation / "needs you" item as resolved.', input_schema: { type: 'object', properties: { escalation_id: { type: 'string' } }, required: ['escalation_id'] } },
];

const ACTIONS = new Set(['pause_chasing', 'resume_chasing', 'snooze_invoice', 'mark_invoice_paid', 'resolve_escalation']);
const rand = (n: number) => 'R' + (Number(n) || 0).toLocaleString('en-ZA');

async function execute(clinic: any, role: string, name: string, input: any): Promise<unknown> {
  if (ACTIONS.has(name) && !roleAtLeast(role, 'admin')) {
    return { error: 'That action needs admin or owner access. You have read-only access.' };
  }
  const tz = clinic.timezone ?? 'Africa/Johannesburg';
  switch (name) {
    case 'get_day_brief': {
      const [today, recent, overdue, esc] = await Promise.all([
        getTodaysBookings(clinic.id, tz), listClinicBookings(clinic.id, 60),
        getChaseableInvoices(clinic.id), getOpenEscalations(clinic.id),
      ]);
      const cancellations = (recent as any[]).filter((b) => b.status === 'cancelled').slice(0, 6);
      const overdueTotal = (overdue as any[]).reduce((s, i) => s + (Number(i.amount_due) || 0), 0);
      return {
        today_appointments: (today as any[]).map((b: any) => ({ service: b.service, start: b.start_at, status: b.status })),
        recent_cancellations: cancellations.map((b: any) => ({ service: b.service, when: b.start_at })),
        overdue_invoices: { count: (overdue as any[]).length, total: rand(overdueTotal) },
        needs_you: (esc as any[]).map((e: any) => ({ id: e.id, reason: e.reason })),
      };
    }
    case 'list_overdue_invoices': {
      const inv = await getChaseableInvoices(clinic.id);
      return (inv as any[]).map((i: any) => ({ invoice_number: i.invoice_number, customer: i.contact_name, amount: rand(i.amount_due), due_date: i.due_date, stage: i.chase_stage }));
    }
    case 'list_bookings': {
      const b = await listClinicBookings(clinic.id, 40);
      return (b as any[]).map((x: any) => ({ service: x.service, start: x.start_at, status: x.status, customer: (Array.isArray(x.clients) ? x.clients[0] : x.clients)?.name }));
    }
    case 'list_conversations': {
      const c = await listConversations(clinic.id, 30);
      return (c as any[]).map((x: any) => ({ customer: (Array.isArray(x.clients) ? x.clients[0] : x.clients)?.name, channel: x.channel, status: x.status, last: x.last_message_at }));
    }
    case 'get_insights': {
      const sinceISO = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { events, bookings } = await getReportData(clinic.id, sinceISO);
      const convCount = await countConversations(clinic.id, sinceISO);
      const stats = computeReportStats(events as any[], bookings as any[]);
      const insights = computeInsights(bookings as any[], convCount, stats.bookedN);
      return { revenue_captured: rand(stats.bookedR), revenue_recovered: rand(stats.recoveredR), bookings: stats.bookedN, conversations: convCount, conversion_rate: insights.conversionRate + '%', no_show_rate: stats.noShowRate + '%', top_service: insights.topService, busiest_day: insights.busiestDay };
    }
    case 'pause_chasing': await setChasingPaused(clinic.id, true); return { ok: true, message: 'Invoice chasing paused.' };
    case 'resume_chasing': await setChasingPaused(clinic.id, false); return { ok: true, message: 'Invoice chasing resumed.' };
    case 'snooze_invoice': {
      const inv = await getInvoiceByNumber(clinic.id, input.invoice_number);
      if (!inv) return { error: `No invoice ${input.invoice_number} found.` };
      const days = Number(input.days) > 0 ? Number(input.days) : 5;
      await snoozeInvoice(inv.id, new Date(Date.now() + days * 86_400_000).toISOString());
      return { ok: true, message: `Snoozed ${input.invoice_number} for ${days} days.` };
    }
    case 'mark_invoice_paid': {
      const inv = await getInvoiceByNumber(clinic.id, input.invoice_number);
      if (!inv) return { error: `No invoice ${input.invoice_number} found.` };
      await markInvoicePaidById(inv.id);
      return { ok: true, message: `Marked ${input.invoice_number} as paid.` };
    }
    case 'resolve_escalation': {
      const ok = await resolveEscalation(clinic.id, String(input.escalation_id));
      return ok ? { ok: true, message: 'Marked as resolved.' } : { error: 'That item was not found.' };
    }
    default: return { error: 'Unknown tool' };
  }
}

function systemPrompt(clinic: any): string {
  const today = new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: clinic.timezone ?? 'Africa/Johannesburg' });
  return `You are Remi, the AI office-manager copilot for "${clinic.name}". You are the manager's sharp, calm chief of staff.
Today is ${today}.

You help run the day: brief the manager, answer questions from live data, and take actions on request via your tools.
- When the manager opens the session or asks for their day/brief, call get_day_brief and give a clear, scannable rundown: what's on today, any cancellations, the overdue-invoice position, and anything needing them.
- Be concise and professional — short sections, bullet points, no fluff. South African English; money in Rand (R).
- You may take internal, reversible actions (pause/resume chasing, snooze or mark an invoice paid, resolve a needs-you item) when asked. Confirm clearly once done.
- You must NEVER message a customer or send anything outward yourself. If asked, say the manager should do that from the relevant screen for now.
- If a request isn't something your tools can do, say so plainly rather than guessing.`;
}

// Map our JSON-schema tool defs to Gemini's function-declaration format.
const TYPE_MAP: Record<string, string> = { object: 'OBJECT', string: 'STRING', number: 'NUMBER', integer: 'NUMBER', boolean: 'BOOLEAN', array: 'ARRAY' };
function convSchema(s: any): any {
  const out: any = { type: TYPE_MAP[s?.type] ?? 'STRING' };
  if (s?.description) out.description = s.description;
  if (s?.properties) { out.properties = {}; for (const [k, v] of Object.entries(s.properties)) out.properties[k] = convSchema(v); }
  if (s?.required) out.required = s.required;
  if (s?.items) out.items = convSchema(s.items);
  return out;
}
const geminiTools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: convSchema(t.input_schema) })) }];

/** Run the copilot. `history` = [{role:'user'|'assistant', content:string}], latest last. */
export async function runAssistant(clinic: any, role: string, history: { role: string; content: string }[]): Promise<string> {
  if (!config.gemini.apiKey) return 'The assistant needs GEMINI_API_KEY configured on the server.';
  const contents: any[] = history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const systemInstruction = systemPrompt(clinic);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await ai.models.generateContent({ model: config.gemini.model, contents, config: { systemInstruction, tools: geminiTools } });
    const calls = result.functionCalls;
    if (calls && calls.length > 0) {
      contents.push({ role: 'model', parts: calls.map((fc: any) => ({ functionCall: fc })) });
      const respParts: any[] = [];
      for (const fc of calls) {
        let out: unknown;
        try { out = await execute(clinic, role, fc.name as string, fc.args ?? {}); }
        catch (e) { out = { error: String(e) }; }
        respParts.push({ functionResponse: { name: fc.name, id: fc.id, response: { result: out } } });
      }
      contents.push({ role: 'user', parts: respParts });
      continue;
    }
    const text = (result.text ?? '').trim();
    return text || 'Sorry, could you rephrase that?';
  }
  return 'That took more steps than expected — could you try asking in a simpler way?';
}
