/**
 * Invoice-source registry + sync orchestrator.
 *
 * One place that knows every source adapter. syncInvoicesForClinic pulls the
 * clinic's currently-overdue invoices from its connected source, upserts them
 * into Remi's invoices table, and reconciles anything that's been paid upstream
 * so the chaser stops chasing it.
 */
import type { InvoiceSource } from './types';
import { xeroSource } from './xero';
import { quickbooksSource } from './quickbooks';
import { sageSource } from './sage';
import { googleSheetSource } from './googleSheet';
import { getClinic, upsertInvoice, reconcileSourceInvoices, setInvoiceSourceData } from '../../db';

const REGISTRY: Record<string, InvoiceSource> = {
  xero: xeroSource,
  quickbooks: quickbooksSource,
  sage: sageSource,
  gsheet: googleSheetSource,
};

export function getInvoiceSource(key?: string | null): InvoiceSource | null {
  return key ? REGISTRY[key] ?? null : null;
}

export function listInvoiceSources(): { key: string; label: string; kind: string }[] {
  return Object.values(REGISTRY).map((s) => ({ key: s.key, label: s.label, kind: s.kind }));
}

/** Pull + upsert overdue invoices for one clinic from its connected source. */
export async function syncInvoicesForClinic(clinicId: string): Promise<{ synced: number; cleared: number } | null> {
  const clinic = await getClinic(clinicId);
  const source = getInvoiceSource(clinic?.invoice_source);
  if (!clinic || !source) return null;

  const persist = (patch: { tokens?: any; config?: any }) => setInvoiceSourceData(clinicId, patch);
  const invoices = await source.fetchOverdue(clinic, persist);

  for (const inv of invoices) {
    await upsertInvoice(clinicId, {
      invoice_number: inv.invoice_number,
      external_id: inv.external_id,
      contact_name: inv.contact_name,
      contact_phone: inv.contact_phone ?? undefined,
      contact_email: inv.contact_email ?? undefined,
      amount_due: inv.amount_due,
      currency: inv.currency,
      due_date: inv.due_date,
      source: source.key,
    });
  }
  const cleared = await reconcileSourceInvoices(clinicId, source.key, invoices.map((i) => i.external_id));
  console.log(`[invoice-sync] ${source.label}: ${invoices.length} overdue synced, ${cleared} marked paid for ${clinic.name ?? clinicId}`);
  return { synced: invoices.length, cleared };
}
