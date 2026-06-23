/**
 * Invoice-chasing pure logic — ported from the standalone PaidUp engine.
 *
 * Everything in this file is PURE (no DB, no network) so it can be unit-tested
 * in isolation, the same way Remi keeps computeReportStats / buildProactiveParams
 * testable. The impure pieces (Gemini message generation, DB reads/writes,
 * sending) live in chaseMessage.ts / chaseRunner.ts / db.ts.
 */

export type ChaseCadence = { stage1: number; stage2: number; stage3: number; cooldown: number };

/** Default escalation schedule: friendly at 1 day overdue, firm at 7, final at 21,
 *  never re-chasing the same contact within 6 days. Matches the PaidUp original. */
export const DEFAULT_CADENCE: ChaseCadence = { stage1: 1, stage2: 7, stage3: 21, cooldown: 6 };

export const STAGES: Record<number, { label: string }> = {
  1: { label: 'friendly reminder' },
  2: { label: 'firm follow-up' },
  3: { label: 'final notice' },
};

export type ChaseInvoiceState = {
  days_overdue: number;
  chase_stage: number;
  last_chased_at?: string | null;
  snoozed_until?: string | null;
};

/**
 * Decide which stage (1–3) an invoice should be chased at right now, or null if
 * it's not due. Respects the snooze window and the re-chase cooldown.
 * `now` is injectable so tests are deterministic.
 */
export function nextChaseStage(
  invoice: ChaseInvoiceState,
  cadence: ChaseCadence = DEFAULT_CADENCE,
  now: Date = new Date(),
): number | null {
  const c = cadence ?? DEFAULT_CADENCE;
  const s1 = c.stage1 ?? 1, s2 = c.stage2 ?? 7, s3 = c.stage3 ?? 21, cool = c.cooldown ?? 6;
  const { days_overdue, chase_stage, last_chased_at, snoozed_until } = invoice;

  if (snoozed_until && new Date(snoozed_until) > now) return null;

  const daysSinceLastChase = last_chased_at
    ? Math.floor((now.getTime() - new Date(last_chased_at).getTime()) / 86_400_000)
    : 999;
  if (daysSinceLastChase < cool) return null;

  if (chase_stage === 0 && days_overdue >= s1) return 1;
  if (chase_stage === 1 && days_overdue >= s2) return 2;
  if (chase_stage === 2 && days_overdue >= s3) return 3;
  return null;
}

/** Whole days an invoice is overdue given its due date (negative ⇒ not yet due). */
export function daysOverdue(dueDate: string | Date, now: Date = new Date()): number {
  const due = new Date(typeof dueDate === 'string' ? `${String(dueDate).slice(0, 10)}T00:00:00Z` : dueDate);
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.floor((today.getTime() - due.getTime()) / 86_400_000);
}

// ── Safety key derivation (opt-out matching) ─────────────────────────────────

/** Collapse a phone number to a stable key: SA numbers → last 9 digits. */
export function phoneKey(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length < 9 ? null : digits.slice(-9);
}

/** Normalise an email to a stable lowercased key. */
export function emailKey(raw?: string | null): string | null {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  return e.includes('@') ? e : null;
}

// ── Money helpers ────────────────────────────────────────────────────────────

export function formatMoney(amount: number | string, currency = 'ZAR'): string {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: currency || 'ZAR' }).format(n);
  } catch {
    return `${currency || ''}${n.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
  }
}

export function amountTier(amount: number | string): 'low' | 'medium' | 'high' {
  const n = Number(amount) || 0;
  if (n >= 10_000) return 'high';
  if (n >= 1_000) return 'medium';
  return 'low';
}

// ── Deterministic fallback message (used when Gemini is off or fails) ─────────

export function buildChaseFallback(o: {
  contactName?: string | null;
  invoiceNumber?: string | null;
  amount: number | string;
  currency?: string;
  daysOverdue: number;
  stage: number;
  senderName: string;
}): string {
  const name = o.contactName?.trim() || 'there';
  const amt = formatMoney(o.amount, o.currency);
  const inv = o.invoiceNumber ? ` (invoice ${o.invoiceNumber})` : '';
  const from = o.senderName;
  if (o.stage <= 1) {
    return `Hi ${name}, a friendly reminder from ${from} that ${amt}${inv} is now overdue. ` +
      `It may simply have slipped through — when you have a moment, could you arrange payment? Thank you!`;
  }
  if (o.stage === 2) {
    return `Hi ${name}, following up from ${from} on ${amt}${inv}, now ${o.daysOverdue} days overdue. ` +
      `Could you let us know when we can expect payment, or reply if anything's holding it up?`;
  }
  return `Hi ${name}, this is a final notice from ${from} regarding ${amt}${inv}, now ${o.daysOverdue} days overdue. ` +
    `Please arrange payment to avoid further steps. If you've already paid, reply PAID and we'll close it off.`;
}

// ── Inbound reply classification (regex; AI parsing can layer on later) ───────

export type ReplyIntent = 'stop' | 'paid' | 'dispute' | 'snooze' | 'unknown';

/** Classify a free-text reply to a chase. Precedence: stop > paid > dispute > snooze. */
export function classifyInvoiceReply(body: string): ReplyIntent {
  const t = (body || '').toLowerCase().trim();
  if (!t) return 'unknown';
  if (/\b(stop|unsubscribe|opt[\s-]?out|remove me|leave me alone|no more)\b/.test(t)) return 'stop';
  if (/\b(paid|payment made|i'?ve paid|i have paid|settled|eft (sent|done)|transferred|just sent)\b/.test(t)) return 'paid';
  if (/\b(dispute|disputed|wrong|incorrect|don'?t owe|not mine|already cancelled|query this|never received)\b/.test(t)) return 'dispute';
  if (/\b(next week|month[- ]?end|end of (the )?month|more time|few days|by friday|by monday|on the \d{1,2}|pay (you )?(on|by|next))\b/.test(t)) return 'snooze';
  return 'unknown';
}

// ── CSV import parsing (pure) ────────────────────────────────────────────────

export type ParsedInvoiceRow = {
  invoice_number: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  amount_due: number;
  due_date: string; // YYYY-MM-DD
  currency: string;
};

const HEADER_ALIASES: Record<string, keyof ParsedInvoiceRow> = {
  invoice_number: 'invoice_number', invoice: 'invoice_number', 'invoice number': 'invoice_number', number: 'invoice_number', ref: 'invoice_number',
  contact_name: 'contact_name', name: 'contact_name', client: 'contact_name', customer: 'contact_name', 'contact name': 'contact_name',
  contact_phone: 'contact_phone', phone: 'contact_phone', mobile: 'contact_phone', cell: 'contact_phone', 'contact phone': 'contact_phone',
  contact_email: 'contact_email', email: 'contact_email', 'contact email': 'contact_email',
  amount_due: 'amount_due', amount: 'amount_due', total: 'amount_due', due: 'amount_due', 'amount due': 'amount_due',
  due_date: 'due_date', 'due date': 'due_date', date: 'due_date', duedate: 'due_date',
  currency: 'currency',
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Normalise a date token to YYYY-MM-DD. Accepts ISO, DD/MM/YYYY, YYYY/MM/DD. */
export function normaliseDate(raw: string): string | null {
  const s = (raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  let m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/); // YYYY/MM/DD
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

/** Parse CSV text into invoice rows + per-row errors. Header order is flexible. */
export function parseInvoiceCsv(text: string): { rows: ParsedInvoiceRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = (text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows: [], errors: ['CSV needs a header row and at least one data row'] };

  const headers = splitCsvLine(lines[0]).map((h) => HEADER_ALIASES[h.toLowerCase()] ?? null);
  const rows: ParsedInvoiceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const rec: any = { currency: 'ZAR' };
    headers.forEach((key, idx) => { if (key) rec[key] = cells[idx] ?? ''; });

    const amount = Number(String(rec.amount_due ?? '').replace(/[^\d.-]/g, ''));
    const due = normaliseDate(rec.due_date ?? '');
    if (!rec.contact_phone && !rec.contact_email) { errors.push(`Row ${i + 1}: no phone or email — skipped`); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { errors.push(`Row ${i + 1}: invalid amount "${rec.amount_due}" — skipped`); continue; }
    if (!due) { errors.push(`Row ${i + 1}: invalid due date "${rec.due_date}" — skipped`); continue; }

    rows.push({
      invoice_number: String(rec.invoice_number || `INV-${i}`).trim(),
      contact_name: String(rec.contact_name || '').trim(),
      contact_phone: String(rec.contact_phone || '').trim(),
      contact_email: String(rec.contact_email || '').trim(),
      amount_due: amount,
      due_date: due,
      currency: String(rec.currency || 'ZAR').trim().toUpperCase(),
    });
  }
  return { rows, errors };
}
