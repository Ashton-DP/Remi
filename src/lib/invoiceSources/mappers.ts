/**
 * PURE mappers: each accounting provider's invoice JSON → Remi's normalised
 * invoice shape. No network/DB, so they're unit-tested directly. The impure
 * fetch/OAuth lives in the per-provider adapters; they call these.
 */

export type NormalizedInvoice = {
  external_id: string;          // provider's invoice id (for reconciliation)
  invoice_number: string;       // human ref (DocNumber etc.); falls back to external_id
  contact_name: string;
  contact_phone: string | null;
  contact_email: string | null;
  amount_due: number;
  currency: string;
  due_date: string;             // YYYY-MM-DD
};

/** Normalise any date-ish value to YYYY-MM-DD. */
export function toDateOnly(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/** Whole days a due date is past today (never negative). */
export function daysOverdue(dueDate: unknown, now: Date = new Date()): number {
  const d = toDateOnly(dueDate);
  if (!d) return 0;
  const due = new Date(`${d}T00:00:00Z`).getTime();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((today - due) / 86_400_000));
}

/** Build a phone string from a Xero contact's phones[] (cc/area/number split). */
export function assemblePhone(phones: any[] | undefined | null): string | null {
  if (!phones || !phones.length) return null;
  const withNum = phones.filter((p) => p.phoneNumber && String(p.phoneNumber).trim());
  if (!withNum.length) return null;
  const pick = withNum.find((p) => p.phoneType === 'MOBILE')
    || withNum.find((p) => p.phoneType === 'DEFAULT')
    || withNum[0];
  const cc = String(pick.phoneCountryCode || '').replace(/\D/g, '');
  const ac = String(pick.phoneAreaCode || '').replace(/\D/g, '');
  const num = String(pick.phoneNumber || '').replace(/\D/g, '');
  const raw = cc ? `+${cc}${ac}${num}` : `${ac}${num}`;
  return raw || null;
}

// ── Xero ─────────────────────────────────────────────────────────────────────
/** Map one Xero ACCREC invoice + its resolved contact details. */
export function mapXeroInvoice(inv: any, contact: { email?: string | null; phone?: string | null } = {}): NormalizedInvoice {
  const id = String(inv.invoiceID ?? inv.InvoiceID ?? '');
  return {
    external_id: id,
    invoice_number: String(inv.invoiceNumber ?? inv.InvoiceNumber ?? id),
    contact_name: inv.contact?.name ?? inv.Contact?.Name ?? 'Unknown',
    contact_email: contact.email ?? null,
    contact_phone: contact.phone ?? null,
    amount_due: Number(inv.amountDue ?? inv.AmountDue ?? 0),
    currency: inv.currencyCode ?? inv.CurrencyCode ?? 'ZAR',
    due_date: toDateOnly(inv.dueDate ?? inv.DueDate) ?? new Date().toISOString().slice(0, 10),
  };
}

// ── QuickBooks Online ─────────────────────────────────────────────────────────
export function mapQboInvoice(inv: any): NormalizedInvoice {
  const id = String(inv.Id ?? '');
  return {
    external_id: id,
    invoice_number: String(inv.DocNumber || id),
    contact_name: inv.CustomerRef?.name ?? 'Unknown',
    contact_email: inv.BillEmail?.Address ?? null,
    contact_phone: null, // QBO doesn't expose phone on the invoice
    amount_due: Number(inv.Balance ?? 0),
    currency: inv.CurrencyRef?.value ?? 'ZAR',
    due_date: toDateOnly(inv.DueDate) ?? new Date().toISOString().slice(0, 10),
  };
}

// ── Sage Business Cloud ───────────────────────────────────────────────────────
/** Is this Sage sales invoice chaseable (unpaid + overdue) as of `today`? */
export function isSageChaseable(inv: any, today: string): boolean {
  const statusId = inv.status?.id || inv.status || '';
  if (!['OUTSTANDING', 'PART_PAID', 'ACTIVE'].includes(statusId)) return false;
  if (!inv.due_date || String(inv.due_date) >= today) return false;
  return true;
}

export function mapSageInvoice(inv: any): NormalizedInvoice {
  const id = String(inv.id ?? '');
  const contact = inv.contact || {};
  return {
    external_id: id,
    invoice_number: String(inv.invoice_number || inv.displayed_as || id),
    contact_name: contact.displayed_as || contact.name || 'Unknown',
    contact_email: contact.email ?? null,
    contact_phone: contact.telephone || contact.mobile_telephone || null,
    amount_due: Number(inv.outstanding_amount ?? inv.total_amount ?? 0),
    currency: inv.currency?.id || 'ZAR',
    due_date: toDateOnly(inv.due_date) ?? today(),
  };
}
function today() { return new Date().toISOString().slice(0, 10); }
