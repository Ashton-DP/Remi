// White-label domain helper tests. Run: tsx tests/emailDomain.test.ts
import assert from 'node:assert';
import { validateDomain, emailOnDomain } from '../src/lib/resendDomains';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('white-label email domains');

test('validateDomain normalises scheme/www/path', () => {
  assert.equal(validateDomain('https://www.EdenMediSpa.co.za/contact'), 'edenmedispa.co.za');
  assert.equal(validateDomain('edenmedispa.co.za'), 'edenmedispa.co.za');
});
test('validateDomain rejects junk', () => {
  assert.equal(validateDomain('not a domain'), null);
  assert.equal(validateDomain('foo'), null);
  assert.equal(validateDomain(''), null);
});
test('emailOnDomain matches domain + subdomains, rejects others', () => {
  assert.equal(emailOnDomain('billing@edenmedispa.co.za', 'edenmedispa.co.za'), true);
  assert.equal(emailOnDomain('billing@mail.edenmedispa.co.za', 'edenmedispa.co.za'), true);
  assert.equal(emailOnDomain('billing@gmail.com', 'edenmedispa.co.za'), false);
  assert.equal(emailOnDomain('notanemail', 'edenmedispa.co.za'), false);
});

console.log(`\n${passed} email-domain tests passed ✅`);
