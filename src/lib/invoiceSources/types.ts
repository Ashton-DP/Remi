import type { NormalizedInvoice } from './mappers';

export type ClinicLike = {
  id: string;
  name?: string | null;
  invoice_source?: string | null;       // 'xero' | 'quickbooks' | 'sage' | 'gsheet'
  invoice_source_tokens?: any;          // jsonb — OAuth token set
  invoice_source_config?: any;          // jsonb — { xero_tenant_id, realm_id, sage_business_id, sheet_url }
};

/** Persist refreshed tokens / config back to the clinic (passed into adapters
 *  so they stay decoupled from the DB layer). */
export type PersistFn = (patch: { tokens?: any; config?: any }) => Promise<void>;

export interface InvoiceSource {
  key: string;
  label: string;
  kind: 'oauth' | 'config';
  /** OAuth: where to send the user to grant access. `state` round-trips the clinic id. */
  getAuthUrl?(state: string): string;
  /** OAuth: exchange the callback for tokens; returns what to persist on the clinic. */
  handleCallback?(query: Record<string, string>, clinicId: string): Promise<{ tokens: any; config: any; name?: string }>;
  /** All sources: pull the currently-overdue invoices for a connected clinic. */
  fetchOverdue(clinic: ClinicLike, persist: PersistFn): Promise<NormalizedInvoice[]>;
}
