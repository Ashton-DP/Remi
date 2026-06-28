/**
 * Referral attribution — pure helpers. A referrer shares a WhatsApp link with a
 * code baked into the prefilled message; the friend taps it and their first
 * message to the clinic carries the code, which we parse and attribute.
 */
import crypto from 'node:crypto';

// Unambiguous alphabet (no 0/O/1/I) so spoken/typed codes survive.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short, unique-ish referral code, e.g. "REF-7K3QP". */
export function generateReferralCode(): string {
  const bytes = crypto.randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `REF-${s}`;
}

/** Extract a referral code from a message ("…referred by Jane (ref:REF-7K3QP)").
 *  Tolerant of case and the ref: prefix being present or not. Pure. */
export function extractReferralCode(text: string): string | null {
  if (!text) return null;
  const m = text.match(/\bref[:\s-]*\s*(REF-[A-Z0-9]{5})\b/i) || text.match(/\b(REF-[A-Z0-9]{5})\b/i);
  return m ? m[1].toUpperCase() : null;
}

/** Build the WhatsApp share link the referrer forwards to friends. The friend
 *  taps it → WhatsApp opens to the clinic with the code already in the message. */
export function buildReferralShareLink(clinicWhatsAppNumber: string, referrerName: string, code: string): string {
  const num = (clinicWhatsAppNumber || '').replace(/[^\d]/g, '');
  const text = `Hi! I'd like to book — ${referrerName} referred me (ref:${code})`;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}
