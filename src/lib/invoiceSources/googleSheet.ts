/**
 * Google Sheet invoice source — the zero-OAuth "automatic" option.
 *
 * The business keeps invoices in a Google Sheet and publishes it to the web as
 * CSV (File → Share → Publish to web → Comma-separated values). They paste that
 * URL once; Remi fetches + parses it on every sync. Same column format as the
 * manual CSV import, so we reuse parseInvoiceCsv.
 */
import type { InvoiceSource, ClinicLike } from './types';
import type { NormalizedInvoice } from './mappers';
import { parseInvoiceCsv } from '../chase';

export const googleSheetSource: InvoiceSource = {
  key: 'gsheet',
  label: 'Google Sheet',
  kind: 'config',

  async fetchOverdue(clinic: ClinicLike): Promise<NormalizedInvoice[]> {
    const url = clinic.invoice_source_config?.sheet_url;
    if (!url) throw new Error('No sheet_url configured for this clinic');

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Google Sheet fetch ${res.status}`);
    const text = await res.text();
    if (/<html/i.test(text.slice(0, 200))) {
      throw new Error('Sheet URL returned HTML, not CSV — use "Publish to web → CSV", not the share link');
    }

    const { rows } = parseInvoiceCsv(text);
    const today = new Date().toISOString().slice(0, 10);
    return rows
      .filter((r) => r.due_date <= today) // only overdue
      .map((r): NormalizedInvoice => ({
        external_id: r.invoice_number,
        invoice_number: r.invoice_number,
        contact_name: r.contact_name,
        contact_phone: r.contact_phone || null,
        contact_email: r.contact_email || null,
        amount_due: r.amount_due,
        currency: r.currency,
        due_date: r.due_date,
      }));
  },
};
