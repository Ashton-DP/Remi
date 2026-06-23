/**
 * QuickBooks Online invoice source — OAuth2 + overdue sync (ported from PaidUp).
 */
import type { InvoiceSource, ClinicLike, PersistFn } from './types';
import { mapQboInvoice, type NormalizedInvoice } from './mappers';
import { config } from '../../config';

const AUTH = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API = 'https://quickbooks.api.intuit.com/v3/company';
const cfg = () => config.invoiceSources.quickbooks;

async function fetchTokens(params: Record<string, string>) {
  const c = cfg();
  const creds = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}`, Accept: 'application/json' },
    body: new URLSearchParams({ redirect_uri: c.redirectUri, ...params }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QBO token ${res.status}: ${data.error_description || data.error || ''}`);
  return data;
}

async function qboGet(path: string, realmId: string, accessToken: string) {
  const res = await fetch(`${API}/${realmId}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QBO API ${path} ${res.status}`);
  return data;
}

export const quickbooksSource: InvoiceSource = {
  key: 'quickbooks',
  label: 'QuickBooks',
  kind: 'oauth',

  getAuthUrl(state: string) {
    const c = cfg();
    const p = new URLSearchParams({
      client_id: c.clientId, scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: c.redirectUri, response_type: 'code', state,
    });
    return `${AUTH}?${p}`;
  },

  async handleCallback(query, _clinicId) {
    const realmId = query.realmId;
    if (!realmId) throw new Error('QBO callback missing realmId');
    const tokens = await fetchTokens({ grant_type: 'authorization_code', code: query.code });
    tokens.expires_at = Date.now() + (tokens.expires_in || 3600) * 1000;
    let name = 'QuickBooks business';
    try {
      const info = await qboGet(`/companyinfo/${realmId}?minorversion=65`, realmId, tokens.access_token);
      name = info.CompanyInfo?.CompanyName || name;
    } catch { /* non-fatal */ }
    return { tokens, config: { realm_id: realmId }, name };
  },

  async fetchOverdue(clinic: ClinicLike, persist: PersistFn): Promise<NormalizedInvoice[]> {
    const tokens = clinic.invoice_source_tokens;
    const realmId = clinic.invoice_source_config?.realm_id;
    if (!tokens?.refresh_token || !realmId) throw new Error('QuickBooks not connected');

    let access = tokens.access_token;
    if (!tokens.expires_at || Date.now() >= tokens.expires_at - 60_000) {
      const fresh = await fetchTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      fresh.expires_at = Date.now() + (fresh.expires_in || 3600) * 1000;
      await persist({ tokens: fresh });
      access = fresh.access_token;
    }

    const today = new Date().toISOString().slice(0, 10);
    const out: NormalizedInvoice[] = [];
    let offset = 0;
    const page = 200;
    for (;;) {
      const q = `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${today}' STARTPOSITION ${offset + 1} MAXRESULTS ${page}`;
      const data = await qboGet(`/query?query=${encodeURIComponent(q)}&minorversion=65`, realmId, access);
      const items: any[] = data.QueryResponse?.Invoice || [];
      if (!items.length) break;
      for (const inv of items) out.push(mapQboInvoice(inv));
      if (items.length < page) break;
      offset += page;
    }
    return out;
  },
};
