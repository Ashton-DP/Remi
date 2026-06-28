// Security-relevant pure-logic tests. Run: tsx tests/security.test.ts
import assert from 'node:assert';
import crypto from 'node:crypto';
import { isAllowedSheetUrl } from '../src/lib/invoiceSources/googleSheet';
import { encryptField, decryptField } from '../src/lib/secretCrypto';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('security');

test('isAllowedSheetUrl accepts real Google published-CSV URLs', () => {
  assert.ok(isAllowedSheetUrl('https://docs.google.com/spreadsheets/d/abc/pub?output=csv'));
  assert.ok(isAllowedSheetUrl('https://sheets.google.com/x'));
  assert.ok(isAllowedSheetUrl('https://doc-0s-1c-sheets.googleusercontent.com/pub/x'));
});

test('isAllowedSheetUrl blocks SSRF targets', () => {
  // cloud metadata, internal hosts, localhost, raw IPs, non-https, look-alikes
  for (const bad of [
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/latest/meta-data/',
    'http://localhost:6379/',
    'https://127.0.0.1/',
    'http://docs.google.com/x',                 // not https
    'https://docs.google.com.evil.com/x',       // suffix look-alike
    'https://evil.com/docs.google.com',         // path look-alike
    'https://googleusercontent.com.evil.com/x',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.ok(!isAllowedSheetUrl(bad), `should block: ${bad}`);
  }
});

// ── secret encryption (payment creds / inbox password at rest) ────────────────
test('secretCrypto: no key → plaintext passthrough (opt-in, no behaviour change)', () => {
  delete process.env.PAYMENT_ENC_KEY;
  assert.equal(encryptField('sk_live_abc'), 'sk_live_abc');
  assert.equal(decryptField('sk_live_abc'), 'sk_live_abc');
});

test('secretCrypto: with key → round-trips, ciphertext differs, legacy plaintext still reads', () => {
  process.env.PAYMENT_ENC_KEY = crypto.randomBytes(32).toString('hex');
  const enc = encryptField('sk_live_secret');
  assert.ok(typeof enc === 'string' && enc.startsWith('enc:v1:'), 'should be tagged ciphertext');
  assert.notEqual(enc, 'sk_live_secret');
  assert.equal(decryptField(enc), 'sk_live_secret');           // decrypts back
  assert.equal(encryptField(enc), enc);                        // already-encrypted is a no-op
  assert.equal(decryptField('plaintext-legacy'), 'plaintext-legacy'); // legacy still reads
  delete process.env.PAYMENT_ENC_KEY;
});

console.log(`\n${passed} passed\n`);
