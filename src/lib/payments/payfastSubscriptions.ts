/**
 * PayFast recurring billing (subscriptions). The dominant SA recurring provider.
 *
 * Signup reuses the same /eng/process form as invoices, with subscription fields
 * (subscription_type=1, recurring_amount, frequency, cycles). PayFast fires an
 * ITN to /webhooks/payfast on the first AND every recurring payment, carrying a
 * subscription `token` — that token is our external_subscription_id and the ITN
 * is what activates the membership (the return URL is just UX).
 *
 * fetch/cancel use the PayFast server API (api.payfast.co.za), which signs over
 * the request headers + passphrase. Signature builders are pure → unit-tested.
 */
import crypto from 'node:crypto';
import { config } from '../../config';
import { buildPayfastSignature } from './payfast';
import type { MembershipStatus } from '../clientOs';

/** Our interval → PayFast frequency code (3 = Monthly, 6 = Annual). Pure. */
export function payfastFrequency(interval: 'month' | 'year'): number {
  return interval === 'year' ? 6 : 3;
}

/** Membership ids are prefixed in m_payment_id so the ITN can tell them apart
 *  from invoice payments (which use the bare invoice id). Pure. */
export const PAYFAST_MEMBERSHIP_PREFIX = 'mem_';
export function isMembershipPaymentId(mPaymentId: string): boolean {
  return String(mPaymentId || '').startsWith(PAYFAST_MEMBERSHIP_PREFIX);
}
export function membershipIdFromPaymentId(mPaymentId: string): string {
  return String(mPaymentId || '').slice(PAYFAST_MEMBERSHIP_PREFIX.length);
}

/** Build the signed PayFast subscription form params for a membership. Pure. */
export function buildPayfastSubscriptionParams(
  membership: { id: string; plan_name: string; amount_zar: number; billing_interval?: string },
  client: { name?: string; email?: string },
  creds: { merchant_id?: string; merchant_key?: string; passphrase?: string },
  base: string,
): Record<string, string> {
  const nameParts = String(client.name || 'Customer').split(' ');
  const amount = Number(membership.amount_zar).toFixed(2);
  const interval = membership.billing_interval === 'year' ? 'year' : 'month';
  const params: Record<string, string> = {
    merchant_id: creds.merchant_id || '',
    merchant_key: creds.merchant_key || '',
    return_url: `${base}/membership/${membership.id}/return`,
    cancel_url: `${base}/pay/cancel`,
    notify_url: `${base}/webhooks/payfast`,
    name_first: nameParts[0] || 'Customer',
    name_last: nameParts.slice(1).join(' ') || '',
    email_address: client.email || '',
    m_payment_id: `${PAYFAST_MEMBERSHIP_PREFIX}${membership.id}`,
    amount,                       // first payment, charged today
    item_name: String(membership.plan_name || 'Membership').slice(0, 100),
    subscription_type: '1',
    recurring_amount: amount,     // charged every interval thereafter
    frequency: String(payfastFrequency(interval)),
    cycles: '0',                  // 0 = bill indefinitely until cancelled
  };
  params.signature = buildPayfastSignature(params, creds.passphrase);
  return params;
}

// The PayFast server API is ALWAYS at api.payfast.co.za; sandbox mode is signalled
// by the ?testing=true query param (sandbox.payfast.co.za only hosts the pay UI).
function apiBase(): string {
  return 'https://api.payfast.co.za';
}

/** PayFast API timestamp: ISO 8601 with a numeric offset, no milliseconds, e.g.
 *  2026-06-27T12:34:56+02:00. It rejects the millisecond+Z form toISOString gives.
 *  SAST is UTC+2 year-round (no DST), which PayFast (an SA gateway) expects. Pure. */
export function payfastTimestamp(now: Date = new Date()): string {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  return `${sast.toISOString().replace(/\.\d{3}Z$/, '')}+02:00`;
}

/** PayFast server-API signature: md5 over alphabetically-sorted header+body+passphrase,
 *  url-encoded PHP-style (spaces as '+'). Pure. */
export function buildPayfastApiSignature(fields: Record<string, string>, passphrase?: string): string {
  const all: Record<string, string> = { ...fields };
  if (passphrase) all.passphrase = passphrase;
  const str = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(all[k] ?? '').trim()).replace(/%20/g, '+')}`)
    .join('&');
  return crypto.createHash('md5').update(str).digest('hex');
}

function apiHeaders(creds: { merchant_id?: string; passphrase?: string }, timestamp: string): Record<string, string> {
  const base = { 'merchant-id': creds.merchant_id || '', version: 'v1', timestamp };
  const signature = buildPayfastApiSignature(base, creds.passphrase);
  return { ...base, signature, 'content-type': 'application/json' };
}

/** Verify PayFast merchant credentials via the server-API /ping (validates the
 *  merchant-id + passphrase signature; a 200 means the creds are good). */
export async function verifyPayfastCreds(creds: { merchant_id?: string; passphrase?: string }): Promise<void> {
  const timestamp = payfastTimestamp();
  const res = await fetch(`${apiBase()}/ping?testing=${config.payments.payfastSandbox ? 'true' : 'false'}`, {
    headers: apiHeaders(creds, timestamp),
  });
  if (!res.ok) {
    const d: any = await res.json().catch(() => ({}));
    throw new Error(d?.data?.response || d?.message || `PayFast rejected the credentials (${res.status})`);
  }
}

/** Cancel a PayFast subscription by token (stops all future billing). */
export async function cancelPayfastSubscription(
  creds: { merchant_id?: string; passphrase?: string },
  token: string,
): Promise<void> {
  const timestamp = payfastTimestamp();
  const url = `${apiBase()}/subscriptions/${encodeURIComponent(token)}/cancel${config.payments.payfastSandbox ? '?testing=true' : ''}`;
  const res = await fetch(url, { method: 'PUT', headers: apiHeaders(creds, timestamp) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.code >= 400) throw new Error(data?.data?.response || data?.message || `PayFast ${res.status}`);
}

/** Fetch a PayFast subscription's status + next run date by token (for the daily sync). */
export async function fetchPayfastSubscription(
  creds: { merchant_id?: string; passphrase?: string },
  token: string,
): Promise<{ status: MembershipStatus | null; renewsAt: string | null }> {
  const timestamp = payfastTimestamp();
  const url = `${apiBase()}/subscriptions/${encodeURIComponent(token)}/fetch${config.payments.payfastSandbox ? '?testing=true' : ''}`;
  const res = await fetch(url, { headers: apiHeaders(creds, timestamp) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `PayFast ${res.status}`);
  const d = data?.data?.response ?? data?.data ?? data;
  return { status: mapPayfastStatus(d?.status_text ?? d?.status), renewsAt: d?.run_date ?? null };
}

/** Map a PayFast subscription status to our enum. Pure. Returns null for an
 *  unrecognised status so the sync leaves the membership unchanged (the ITN is
 *  the real source of truth) rather than fail-open to 'active'.
 *  PayFast status: 1=active, 2=cancelled, 3=paused/complete; status_text gives words. */
export function mapPayfastStatus(status: string | number | undefined): MembershipStatus | null {
  const s = String(status ?? '').toLowerCase();
  if (s === '1' || s === 'active') return 'active';
  if (s === '2' || s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === '3' || s === 'paused') return 'paused';
  if (s === 'complete' || s === 'completed') return 'cancelled';
  return null; // unknown/blank — don't guess
}
