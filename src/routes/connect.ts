import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config';
import { safeEqual, qp } from '../lib/dashboardAuth';
import { getInvoiceSource } from '../lib/invoiceSources';
import { isAllowedSheetUrl } from '../lib/invoiceSources/googleSheet';
import { setInvoiceSource } from '../db';

// State = "<clinicId>.<hmac>" so the OAuth callback can trust which clinic to
// attach the connection to (signed with the same secret as intake links).
const STATE_SECRET = config.intake.secret;
export function signState(clinicId: string): string {
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(clinicId).digest('hex').slice(0, 24);
  return `${clinicId}.${sig}`;
}
function verifyState(state: string): string | null {
  const [clinicId, sig] = String(state || '').split('.');
  if (!clinicId || !sig) return null;
  const expect = crypto.createHmac('sha256', STATE_SECRET).update(clinicId).digest('hex').slice(0, 24);
  return safeEqual(sig, expect) ? clinicId : null;
}

const page = (title: string, body: string) =>
  `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;margin:60px auto;padding:0 20px;color:#1e2233">
   <h2>${title}</h2>${body}</body>`;
/** Escape values interpolated into the HTML above (provider key, account name,
 *  error text) — they can be attacker-influenced (URL path, OAuth response). */
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** GET /connect/:provider?clinic_id=&token=  → redirect to the provider's consent screen. */
export async function handleConnectStart(req: Request, res: Response) {
  const tok = config.chase.importToken;
  if (!tok) return res.status(503).type('text/html').send(page('Connect disabled', '<p>Set <code>CHASE_IMPORT_TOKEN</code> (or <code>ONBOARD_TOKEN</code>) to enable connecting an invoice source.</p>'));
  if (!safeEqual(String(qp(req.query.token) ?? ''), tok)) return res.status(403).type('text/html').send(page('Invalid token', '<p>The access token is incorrect.</p>'));

  const providerKey = qp(req.params.provider) ?? '';
  const clinicId = qp(req.query.clinic_id) ?? '';
  if (!clinicId) return res.status(400).type('text/html').send(page('Missing clinic_id', '<p>clinic_id is required.</p>'));

  const source = getInvoiceSource(providerKey);
  if (!source || source.kind !== 'oauth' || !source.getAuthUrl) {
    return res.status(400).type('text/html').send(page('Unknown provider', `<p>"${esc(providerKey)}" is not an OAuth invoice source.</p>`));
  }
  const c = (config.invoiceSources as any)[providerKey];
  if (!c?.clientId) return res.status(503).type('text/html').send(page('Provider not configured', `<p>Set the ${source.label} developer-app credentials (client id/secret) in the server env first.</p>`));

  return res.redirect(source.getAuthUrl(signState(clinicId)));
}

/** GET /connect/:provider/callback?code=&state=  → exchange + store the connection. */
export async function handleConnectCallback(req: Request, res: Response) {
  const providerKey = qp(req.params.provider) ?? '';
  const source = getInvoiceSource(providerKey);
  if (!source || !source.handleCallback) return res.status(400).type('text/html').send(page('Unknown provider', ''));

  const clinicId = verifyState(qp(req.query.state) ?? '');
  if (!clinicId) return res.status(403).type('text/html').send(page('Invalid state', '<p>Could not verify this connection request. Start again from the connect link.</p>'));

  try {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) query[k] = String(Array.isArray(v) ? v[0] : v ?? '');
    const { tokens, config: srcConfig, name } = await source.handleCallback(query, clinicId);
    await setInvoiceSource(clinicId, source.key, tokens, srcConfig);
    return res.type('text/html').send(page(`✅ ${source.label} connected`,
      `<p><b>${esc(name ?? 'Your account')}</b> is now linked. Remi will sync overdue invoices and chase them automatically.</p>`));
  } catch (e: any) {
    console.error('[connect]', providerKey, e?.message ?? e);
    return res.status(500).type('text/html').send(page('Connection failed', `<p>${esc(e?.message ?? e)}</p><p>Please try again.</p>`));
  }
}

/** POST /connect/gsheet  { clinic_id, sheet_url, token } → connect a published-CSV Google Sheet. */
export async function handleConnectSheet(req: Request, res: Response) {
  const tok = config.chase.importToken;
  if (!tok) return res.status(503).json({ error: 'Set CHASE_IMPORT_TOKEN (or ONBOARD_TOKEN) to enable connecting.' });
  const given = String((req.body && req.body.token) ?? qp(req.query.token) ?? '');
  if (!safeEqual(given, tok)) return res.status(403).json({ error: 'Invalid token.' });

  const clinicId = String((req.body && req.body.clinic_id) ?? '').trim();
  const sheetUrl = String((req.body && req.body.sheet_url) ?? '').trim();
  if (!clinicId || !sheetUrl) return res.status(400).json({ error: 'clinic_id and sheet_url are required.' });
  if (!isAllowedSheetUrl(sheetUrl)) return res.status(400).json({ error: 'sheet_url must be a published-to-web Google Sheets CSV URL (docs.google.com).' });

  await setInvoiceSource(clinicId, 'gsheet', null, { sheet_url: sheetUrl });
  return res.json({ ok: true, source: 'gsheet', clinic_id: clinicId });
}
