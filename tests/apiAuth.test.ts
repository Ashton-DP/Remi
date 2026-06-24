// Dashboard API auth helper tests. Run: tsx tests/apiAuth.test.ts
import assert from 'node:assert';
import { extractBearer, roleAtLeast } from '../src/lib/apiAuth';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('dashboard api auth');

test('extractBearer pulls the token', () => {
  assert.equal(extractBearer('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(extractBearer('bearer xyz'), 'xyz'); // case-insensitive
  assert.equal(extractBearer('  Bearer   spaced  '), 'spaced');
});
test('extractBearer rejects missing/malformed', () => {
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer(''), null);
  assert.equal(extractBearer('Token abc'), null);
  assert.equal(extractBearer('abc'), null);
});
test('roleAtLeast ranks owner > admin > staff', () => {
  assert.equal(roleAtLeast('owner', 'admin'), true);
  assert.equal(roleAtLeast('admin', 'admin'), true);
  assert.equal(roleAtLeast('staff', 'admin'), false);
  assert.equal(roleAtLeast('staff', 'staff'), true);
  assert.equal(roleAtLeast('bogus', 'staff'), false);
});

console.log(`\n${passed} api-auth tests passed ✅`);
