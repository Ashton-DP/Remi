/**
 * Xero invoice source — OAuth2 + ACCREC overdue sync over the REST API
 * (no xero-node SDK, to stay consistent with the other fetch-based adapters).
 */
import type { InvoiceSource, ClinicLike, PersistFn } from './types';
import { mapXeroInvoice, assemblePhone, type NormalizedInvoice } from './mappers';
import { config } from '../../config';

const AUTH = 'https://login.xero.com/identity/connect/authorize';
const TOKEN = 'https://identity.xero.com/connect/token';
const API = 'https://api.xero.com/api.xro/2.0';
const CONNECTIONS = 'https://api.xero.com/connections';
const SCOPES = 'openid profile email accounting.invoices.read accounting.contacts.read offline_access';

const cfg = () => config.invoiceSources.xero;

async function exchange(params: Record<string, string>) {
  const c = cfg();
  const creds = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams(params),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Xero token ${res.status}: ${data.error_description || data.error || ''}`);
  return data;
}

async function xeroGet(path: string, accessToken: string, tenantId?: string) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(tenantId ? { 'Xero-tenant-id': tenantId } : {}),
    },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Xero API ${path} ${res.status}`);
  return data;
}

export const xeroSource: InvoiceSource = {
  key: 'xero',
  label: 'Xero',
  kind: 'oauth',

  getAuthUrl(state: string) {
    const c = cfg();
    const p = new URLSearchParams({
      response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri,
      scope: SCOPES, state,
    });
    return `${AUTH}?${p}`;
  },

  async handleCallback(query, _clinicId) {
    const c = cfg();
    const tokens = await exchange({ grant_type: 'authorization_code', code: query.code, redirect_uri: c.redirectUri });
    // Resolve the connected org (tenant) id.
    const conns = await fetch(CONNECTIONS, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } })
      .then((r) => r.json()).catch(() => []);
    const org = Array.isArray(conns) ? conns[0] : null;
    if (!org) throw new Error('No Xero organisation attached to this connection');
    return { tokens, config: { xero_tenant_id: org.tenantId }, name: org.tenantName };
  },

  async fetchOverdue(clinic: ClinicLike, persist: PersistFn): Promise<NormalizedInvoice[]> {
    const tokens = clinic.invoice_source_tokens;
    const tenantId = clinic.invoice_source_config?.xero_tenant_id;
    if (!tokens?.refresh_token || !tenantId) throw new Error('Xero not connected');

    const fresh = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    await persist({ tokens: fresh });
    const access = fresh.access_token;

    const t = new Date().toISOString().slice(0, 10).replace(/-/g, ',');
    const where = encodeURIComponent(`Type=="ACCREC" AND Status=="AUTHORISED" AND DueDate<DateTime(${t})`);
    const data = await xeroGet(`/Invoices?where=${where}&order=DueDate%20ASC&page=1`, access, tenantId);
    const invoices: any[] = data.Invoices || [];

    const contactCache = new Map<string, { email: string | null; phone: string | null }>();
    const out: NormalizedInvoice[] = [];
    for (const inv of invoices) {
      const cid = inv.Contact?.ContactID;
      let contact = { email: null as string | null, phone: null as string | null };
      if (cid) {
        if (contactCache.has(cid)) contact = contactCache.get(cid)!;
        else {
          try {
            const cd = await xeroGet(`/Contacts/${cid}`, access, tenantId);
            const c = (cd.Contacts || [])[0];
            contact = { email: c?.EmailAddress || null, phone: assemblePhone(c?.Phones) };
          } catch { /* leave nulls */ }
          contactCache.set(cid, contact);
        }
      }
      out.push(mapXeroInvoice(inv, contact));
    }
    return out;
  },
};
