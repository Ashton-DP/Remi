/**
 * Application-layer encryption for secrets stored in the DB (per-clinic payment
 * credentials + email-inbox app-password). AES-256-GCM with a key from
 * PAYMENT_ENC_KEY (32 bytes, hex or base64). Encrypted values are tagged `enc:v1:`.
 *
 * Safe-by-default / opt-in: with NO key set, encryptField is a no-op (stores
 * plaintext, unchanged behaviour) and decryptField passes plaintext through. So
 * deploying this changes nothing until PAYMENT_ENC_KEY is set; once set, new
 * writes are encrypted and reads transparently decrypt (legacy plaintext still
 * reads). Generate a key with:  openssl rand -hex 32
 */
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  const raw = process.env.PAYMENT_ENC_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

export function encryptField(plaintext: any): any {
  if (typeof plaintext !== 'string' || plaintext === '' || plaintext.startsWith(PREFIX)) return plaintext;
  const k = key();
  if (!k) return plaintext; // no key configured → leave as plaintext (opt-in)
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptField(value: any): any {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // plaintext/legacy
  const k = key();
  if (!k) { console.error('[secretCrypto] encrypted value present but PAYMENT_ENC_KEY is not set — cannot decrypt'); return value; }
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e: any) {
    console.error('[secretCrypto] decrypt failed:', e?.message);
    return value;
  }
}

// The secret fields inside a clinic's payment_config (provider → field).
const PAYMENT_SECRET_PATHS: [string, string][] = [
  ['stripe', 'secret_key'], ['paystack', 'secret_key'],
  ['payfast', 'passphrase'], ['payfast', 'merchant_key'], ['paypal', 'secret'],
];

function mapPaymentSecrets(cfg: any, fn: (v: any) => any): any {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = { ...cfg };
  for (const [provider, field] of PAYMENT_SECRET_PATHS) {
    if (out[provider] && out[provider][field] != null) {
      out[provider] = { ...out[provider], [field]: fn(out[provider][field]) };
    }
  }
  return out;
}
export const encryptPaymentConfig = (cfg: any) => mapPaymentSecrets(cfg, encryptField);
export const decryptPaymentConfig = (cfg: any) => mapPaymentSecrets(cfg, decryptField);

/** Decrypt the secret fields on a clinic row loaded from the DB (in place-ish). */
export function decryptClinicSecrets<T extends Record<string, any> | null | undefined>(clinic: T): T {
  if (!clinic) return clinic;
  const c: any = clinic;
  if (c.payment_config) c.payment_config = decryptPaymentConfig(c.payment_config);
  if (c.email_inbox && c.email_inbox.pass != null) c.email_inbox = { ...c.email_inbox, pass: decryptField(c.email_inbox.pass) };
  return clinic;
}
