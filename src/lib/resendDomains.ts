/**
 * Resend Domains API wrapper — automated white-label sending-domain onboarding.
 * Lets Remi provision a clinic's own sending domain, hand back the DNS records,
 * and check verification, so 50+ clinics can each send from their own domain
 * without anyone clicking around the Resend console.
 */
import { config } from '../config';

const API = 'https://api.resend.com/domains';

/** Normalise + validate a domain (strips scheme/path/www). Returns null if invalid. Pure. */
export function validateDomain(input: string): string | null {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

/** Is `email` an address on `domain` (or a subdomain of it)? Pure. */
export function emailOnDomain(email: string, domain: string): boolean {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 0) return false;
  const host = e.slice(at + 1);
  return host === domain || host.endsWith('.' + domain);
}

async function rfetch(path: string, method: string, body?: any) {
  const key = config.email.resendApiKey;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend domains ${res.status}: ${data?.message || ''}`);
  return data;
}

export async function createDomain(name: string) { return rfetch('', 'POST', { name }); }
export async function getDomain(id: string) { return rfetch(`/${id}`, 'GET'); }
export async function verifyDomain(id: string) { return rfetch(`/${id}/verify`, 'POST'); }
