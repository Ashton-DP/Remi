import type { Request, Response } from 'express';
import { config } from '../config';
import { safeEqual, qp } from '../lib/dashboardAuth';
import { upsertInvoice, listInvoices, getClinic, setInvoiceSourceData } from '../db';
import { parseInvoiceCsv } from '../lib/chase';
import { getInvoiceSource } from '../lib/invoiceSources';

/** Token check shared by both endpoints. Fail-closed when no token configured. */
function authed(req: Request): boolean {
  const tok = config.chase.importToken;
  if (!tok) return false;
  const given = String((req.body && req.body.token) ?? qp(req.query.token) ?? req.get('X-Chase-Token') ?? '');
  return safeEqual(given, tok);
}

/**
 * POST /invoices/import — bulk-load invoices for a clinic from CSV.
 * Body (JSON or form): { clinic_id, csv, token }. Idempotent on (clinic, invoice_number).
 * Header flexible: invoice_number, contact_name, contact_phone, contact_email, amount_due, due_date, currency.
 */
export async function handleInvoiceImport(req: Request, res: Response) {
  if (!config.chase.importToken) {
    return res.status(503).json({ error: 'Invoice import disabled — set CHASE_IMPORT_TOKEN (or ONBOARD_TOKEN).' });
  }
  if (!authed(req)) return res.status(403).json({ error: 'Invalid token.' });

  const clinicId = String((req.body && req.body.clinic_id) ?? qp(req.query.clinic_id) ?? '').trim();
  const csv = String((req.body && req.body.csv) ?? '');
  if (!clinicId) return res.status(400).json({ error: 'clinic_id is required.' });
  if (!csv.trim()) return res.status(400).json({ error: 'csv is required.' });

  const { rows, errors } = parseInvoiceCsv(csv);
  let imported = 0;
  const failed: string[] = [...errors];
  for (const r of rows) {
    try {
      await upsertInvoice(clinicId, {
        invoice_number: r.invoice_number, contact_name: r.contact_name,
        contact_phone: r.contact_phone, contact_email: r.contact_email,
        amount_due: r.amount_due, currency: r.currency, due_date: r.due_date, source: 'csv',
      });
      imported++;
    } catch (e: any) {
      failed.push(`${r.invoice_number}: ${e.message ?? e}`);
    }
  }
  return res.json({ imported, parsed: rows.length, errors: failed });
}

/** GET /invoices?clinic_id=&token= — list invoices for a clinic (operator visibility). */
export async function handleInvoiceList(req: Request, res: Response) {
  if (!authed(req)) return res.status(403).json({ error: 'Invalid token.' });
  const clinicId = qp(req.query.clinic_id) ?? '';
  if (!clinicId) return res.status(400).json({ error: 'clinic_id is required.' });
  const invoices = await listInvoices(clinicId);
  return res.json({ count: invoices.length, invoices });
}

/**
 * GET /invoices/source-preview?clinic_id=&token=
 * Read-only: counts the overdue invoices Remi can see in the clinic's connected
 * source (Xero/QBO/Sage/Sheet) WITHOUT loading them into the DB or chasing them.
 * Confirms the connection + data pipe on the live server.
 */
export async function handleSourcePreview(req: Request, res: Response) {
  if (!authed(req)) return res.status(403).json({ error: 'Invalid token.' });
  const clinicId = qp(req.query.clinic_id) ?? '';
  if (!clinicId) return res.status(400).json({ error: 'clinic_id is required.' });

  const clinic = await getClinic(clinicId);
  const source = getInvoiceSource(clinic?.invoice_source);
  if (!clinic || !source) return res.json({ connected: false });

  try {
    const inv = await source.fetchOverdue(clinic, (patch) => setInvoiceSourceData(clinicId, patch));
    const total = inv.reduce((s, i) => s + (Number(i.amount_due) || 0), 0);
    return res.json({
      connected: true,
      source: source.key,
      overdue: inv.length,
      total_zar: total,
      with_phone: inv.filter((i) => i.contact_phone).length,
    });
  } catch (e: any) {
    return res.status(502).json({ connected: true, source: source.key, error: e?.message ?? String(e) });
  }
}
