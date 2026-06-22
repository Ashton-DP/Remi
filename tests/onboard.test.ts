// Onboarding parser tests. Run: tsx tests/onboard.test.ts
import assert from 'node:assert';
import { parseServices, parseHours, parseFaqs } from '../src/routes/onboard';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('onboarding parsers');

test('parseServices reads name | minutes | price', () => {
  const s = parseServices('Botox treatment | 45 | 2500\nDermal filler|60|3500');
  assert.deepEqual(s[0], { service: 'Botox treatment', duration_min: 45, price_zar: 2500 });
  assert.deepEqual(s[1], { service: 'Dermal filler', duration_min: 60, price_zar: 3500 });
});

test('parseServices defaults missing duration/price', () => {
  const s = parseServices('Consultation');
  assert.deepEqual(s[0], { service: 'Consultation', duration_min: 30, price_zar: 0 });
});

test('parseHours reads valid day lines, ignores junk', () => {
  const h = parseHours('mon 09:00-17:00\nfri 09:00-16:00\ngarbage line\nsun closed');
  assert.deepEqual(h.mon, [['09:00', '17:00']]);
  assert.deepEqual(h.fri, [['09:00', '16:00']]);
  assert.ok(!h.sun, 'invalid/closed days are omitted');
});

test('parseFaqs reads Q | A and drops blank lines', () => {
  const f = parseFaqs('Where? | George\n\nDo you park? | Yes');
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { q: 'Where?', a: 'George' });
  assert.deepEqual(f[1], { q: 'Do you park?', a: 'Yes' });
});

test('empty inputs produce empty arrays/objects', () => {
  assert.deepEqual(parseServices(''), []);
  assert.deepEqual(parseHours(''), {});
  assert.deepEqual(parseFaqs(''), []);
});

console.log(`\n${passed} onboarding tests passed ✅`);
