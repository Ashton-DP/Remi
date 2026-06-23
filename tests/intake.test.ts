// Intake signed-link tests. Run: tsx tests/intake.test.ts
import assert from 'node:assert';
import { intakeToken, verifyIntakeToken, intakeLink } from '../src/lib/intake';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('intake signed links');

test('token is stable for the same client id', () => {
  assert.equal(intakeToken('client-1'), intakeToken('client-1'));
});

test('verify accepts the correct token', () => {
  assert.ok(verifyIntakeToken('client-1', intakeToken('client-1')));
});

test('verify rejects a wrong token', () => {
  assert.ok(!verifyIntakeToken('client-1', 'not-the-token'));
});

test("verify rejects another client's token (no enumeration)", () => {
  assert.ok(!verifyIntakeToken('client-2', intakeToken('client-1')));
});

test('link contains the client id + token', () => {
  const url = intakeLink('clinic-x', 'client-1');
  assert.ok(url.includes('/intake?c=client-1&t='));
  assert.ok(url.includes(intakeToken('client-1')));
});

console.log(`\n${passed} intake tests passed ✅`);
