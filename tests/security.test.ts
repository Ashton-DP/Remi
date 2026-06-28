// Security-relevant pure-logic tests. Run: tsx tests/security.test.ts
import assert from 'node:assert';
import { isAllowedSheetUrl } from '../src/lib/invoiceSources/googleSheet';

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

console.log(`\n${passed} passed\n`);
