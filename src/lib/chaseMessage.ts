/**
 * AI chase-message generation. Calls Gemini (same model Remi's brain uses) to
 * write a personalised, stage-appropriate payment reminder, and falls back to a
 * deterministic template (buildChaseFallback) whenever Gemini is unconfigured or
 * errors — so chasing never silently stops.
 */
import { config } from '../config';
import { STAGES, amountTier, formatMoney, buildChaseFallback } from './chase';

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(system: string, prompt: string, maxTokens = 600): Promise<string> {
  const key = config.gemini.apiKey;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const models = [config.gemini.model, ...FALLBACK_MODELS.filter((m) => m !== config.gemini.model)];

  let lastErr: unknown;
  for (let round = 0; round < 3; round++) {
    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
            }),
          },
        );
        if (!res.ok) {
          const body = await res.text();
          if ([503, 404, 429].includes(res.status)) { lastErr = new Error(`Gemini ${model} ${res.status}`); continue; }
          throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
        }
        const data: any = await res.json();
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
        if (!text) { lastErr = new Error(`Gemini ${model} returned no text`); continue; }
        return text;
      } catch (err) { lastErr = err; }
    }
    if (round < 2) await sleep(1500 * (round + 1));
  }
  throw lastErr ?? new Error('Gemini: all models failed');
}

export type ChaseMsgInput = {
  contactName?: string | null;
  invoiceNumber?: string | null;
  amount: number | string;
  currency?: string;
  daysOverdue: number;
  dueDate?: string | null;
  stage: number;
  senderName: string;
  channel: 'whatsapp' | 'sms' | 'email';
  hasPayLink?: boolean;
};

/** Generate a chase message; returns AI text on success, deterministic fallback otherwise. */
export async function generateChaseMessage(i: ChaseMsgInput): Promise<string> {
  const fallback = () => buildChaseFallback({
    contactName: i.contactName, invoiceNumber: i.invoiceNumber, amount: i.amount,
    currency: i.currency, daysOverdue: i.daysOverdue, stage: i.stage, senderName: i.senderName,
  });
  if (!config.gemini.apiKey) return fallback();

  const stageInfo = STAGES[i.stage] ?? STAGES[1];
  const tier = amountTier(i.amount);
  const amountStr = formatMoney(i.amount, i.currency);
  const name = i.contactName?.trim() || 'there';

  const system = `You are an accounts-receivable assistant for a South African business called "${i.senderName}".
Write invoice payment reminders that are professional, polite and effective.
South African business culture: direct but respectful, never aggressive. Use South African English, never American spellings.
Keep it concise — these are read on a phone.`;

  const tierGuidance = tier === 'high'
    ? '- High-value invoice: appropriate urgency and professionalism.'
    : tier === 'low' ? '- Small amount: keep it especially light and friendly to preserve the relationship.' : '';

  const prompt = `Write a ${stageInfo.label} payment reminder for this overdue invoice.

- Client: ${name}
- Invoice number: ${i.invoiceNumber ?? '(none)'}
- Amount due: ${amountStr}
- Days overdue: ${i.daysOverdue}
- Due date: ${i.dueDate ?? '(unknown)'}

Channel: ${i.channel === 'email' ? 'Email (professional but warm)' : 'WhatsApp/SMS (conversational, brief, no letter format)'}
Stage ${i.stage} of 3.
${i.stage === 1 ? '- Friendly; assume an oversight. A polite nudge, no pressure.' : ''}
${i.stage === 2 ? '- Firm but professional. Note it is a follow-up; ask for a specific payment date.' : ''}
${i.stage === 3 ? `- Serious final notice. ${tier === 'high' ? 'State that non-payment will be referred to collections.' : 'Mention further steps may follow.'} Professional, not threatening.` : ''}
${tierGuidance}
${i.hasPayLink ? '- A secure payment link is included separately. End with a brief call to action to use the payment link (e.g. "you can settle it via the secure link below") — do NOT write a URL yourself.' : ''}

${i.channel === 'email'
  ? `Format: first line "Subject: <short subject>", then a blank line, then the body addressed to "${name}", signed off as "${i.senderName}".`
  : `Plain text only, no markdown, no subject line, 3-5 sentences. Open with "Hi ${name},".`}
CRITICAL: never output bracketed placeholders like [Name] or [Company]. The client is "${name}" and you write on behalf of "${i.senderName}".
Output only the message text.`;

  try {
    return await callGemini(system, prompt, 600);
  } catch (e: any) {
    console.warn('[chase] Gemini failed, using fallback:', e?.message ?? e);
    return fallback();
  }
}
