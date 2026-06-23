/**
 * Sage Business Cloud Accounting invoice source — OAuth2 + overdue sync
 * (ported from PaidUp).
 */
import type { InvoiceSource, ClinicLike, PersistFn } from './types';
import { mapSageInvoice, isSageChaseable, type NormalizedInvoice } from './mappers';
import { config } from '../../config';

const AUTH = 'https://www.sageone.com/oauth2/auth/central';
const TOKEN = 'https://oauth.accounting.sage.com/token';
const API = 'https://api.accounting.sage.com/v3.1';
const cfg = () => config.invoiceSources.sage;

async function fetchTokens(params: Record<string, string>) {
  const c = cfg();
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sage token ${res.status}: ${data.error_description || data.error || ''}`);
  return data;
}

async function sageGet(path: string, accessToken: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sage API ${path} ${res.status}`);
  return data;
}

export const sageSource: InvoiceSource = {
  key: 'sage',
  label: 'Sage',
  kind: 'oauth',

  getAuthUrl(state: string) {
    const c = cfg();
    const p = new URLSearchParams({
      response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri,
      scope: 'full_access', filter: 'apiv3.1', state,
    });
    return `${AUTH}?${p}`;
  },

  async handleCallback(query, _clinicId) {
    const c = cfg();
    const tokens = await fetchTokens({ grant_type: 'authorization_code', code: query.code, redirect_uri: c.redirectUri });
    let businessId = 'unknown';
    let name = 'Sage business';
    try {
      const biz = await sageGet('/businesses', tokens.access_token);
      const b = (biz.$items || biz.items || [])[0] || {};
      businessId = String(b.id || 'unknown');
      name = b.name || b.displayed_as || name;
    } catch { /* non-fatal */ }
    return { tokens, config: { sage_business_id: businessId }, name };
  },

  async fetchOverdue(clinic: ClinicLike, persist: PersistFn): Promise<NormalizedInvoice[]> {
    const tokens = clinic.invoice_source_tokens;
    if (!tokens?.refresh_token) throw new Error('Sage not connected');

    // Sage access tokens last ~5 min — always refresh before calls.
    const fresh = await fetchTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    await persist({ tokens: fresh });
    const access = fresh.access_token;

    const today = new Date().toISOString().slice(0, 10);
    const out: NormalizedInvoice[] = [];
    let pageNo = 1;
    for (;;) {
      const data = await sageGet(
        `/sales_invoices?items_per_page=200&page=${pageNo}&attributes=contact,outstanding_amount,due_date,invoice_number,currency,status`,
        access,
      );
      const items: any[] = data.$items || data.items || [];
      if (!items.length) break;
      for (const inv of items) if (isSageChaseable(inv, today)) out.push(mapSageInvoice(inv));
      if (!data.$next) break;
      pageNo++;
    }
    return out;
  },
};
