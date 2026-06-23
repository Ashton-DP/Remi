// Clinic knowledge / hours-in-prompt tests. Run: tsx tests/knowledge.test.ts
import assert from 'node:assert';
import { formatHours, buildSystemPrompt } from '../src/brain/systemPrompt';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('clinic knowledge + hours');

test('formatHours lists open days and notes closed ones', () => {
  const h = formatHours({ mon: [['09:00', '17:00']], fri: [['09:00', '16:00']] });
  assert.ok(h.includes('Mon: 09:00-17:00'));
  assert.ok(h.includes('Fri: 09:00-16:00'));
  assert.ok(h.includes('closed Tue, Wed, Thu, Sat, Sun'));
});

test('formatHours handles empty/missing', () => {
  assert.equal(formatHours(null), '');
  assert.equal(formatHours({}), '');
});

test('system prompt includes hours, services and knowledge', () => {
  const p = buildSystemPrompt({
    name: 'Demo', hours_json: { mon: [['09:00', '17:00']] },
    services_json: [{ service: 'Botox', price_zar: 2500, duration_min: 45 }],
    knowledge: 'Free parking out front. Card & EFT accepted.', faq_json: [],
  }, false, false);
  assert.ok(p.includes('Opening hours:'));
  assert.ok(p.includes('Mon: 09:00-17:00'));
  assert.ok(p.includes('Botox: R2500'));
  assert.ok(p.includes('Free parking out front'));
});

test('missing knowledge/hours degrade to safe placeholders', () => {
  const p = buildSystemPrompt({ name: 'Demo' }, false, false);
  assert.ok(p.includes('(none provided)'));
  assert.ok(p.includes('offer to check with the team'));
});

console.log(`\n${passed} knowledge tests passed ✅`);
