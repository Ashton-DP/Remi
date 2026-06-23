import crypto from 'node:crypto';
import { config } from '../config';

// Signed links for the digital patient intake form. The token is an HMAC of the
// client id, so a patient can only open/submit their own form and the links
// aren't guessable/enumerable.

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://www.remireception.com';

export function intakeToken(clientId: string): string {
  return crypto.createHmac('sha256', config.intake.secret).update(clientId).digest('hex').slice(0, 24);
}

export function verifyIntakeToken(clientId: string, token: string): boolean {
  const expected = intakeToken(clientId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function intakeLink(clinicId: string, clientId: string): string {
  const t = intakeToken(clientId);
  return `${PUBLIC_BASE}/intake?c=${encodeURIComponent(clientId)}&t=${t}`;
}
