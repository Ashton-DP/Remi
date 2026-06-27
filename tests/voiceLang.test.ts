// Voice reply-language detection (picks the TTS voice). Run: tsx tests/voiceLang.test.ts
import assert from 'node:assert';
import { detectAfrikaans, detectZulu } from '../src/voice/azureSpeech';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('voice language detection');

const ZU = [
  'Sawubona, ngicela ukubhuka isikhathi namhlanje.',
  'Yebo ngiyabonga, ngifuna ukubona udokotela kusasa.',
  'Cha, malini isikhathi sokwelashwa?',
];
const AF = [
  "Goeie môre, ek wil graag 'n afspraak bespreek vir Vrydag.",
  'Ja dankie, kan ons dit vroeër maak asseblief?',
];
const EN = [
  "Hi, I'd like to book an appointment for Friday please.",
  'Sure, what time works best for you? Enjoy your day!',
];

test('detectZulu: true for isiZulu', () => {
  for (const s of ZU) assert.ok(detectZulu(s), `should be Zulu: ${s}`);
});
test('detectZulu: false for English + Afrikaans', () => {
  for (const s of [...EN, ...AF]) assert.ok(!detectZulu(s), `should NOT be Zulu: ${s}`);
});
test('detectAfrikaans: true for Afrikaans', () => {
  for (const s of AF) assert.ok(detectAfrikaans(s), `should be Afrikaans: ${s}`);
});
test('detectAfrikaans: false for English + isiZulu', () => {
  for (const s of [...EN, ...ZU]) assert.ok(!detectAfrikaans(s), `should NOT be Afrikaans: ${s}`);
});
test('routing precedence: isiZulu never misroutes to Afrikaans', () => {
  // speak() checks Zulu before Afrikaans, so isiZulu must win even if it shared a token.
  for (const s of ZU) assert.ok(detectZulu(s) && !detectAfrikaans(s));
});

console.log(`\n${passed} passed\n`);
