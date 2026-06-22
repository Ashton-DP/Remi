// Messaging channel (WhatsApp/SMS fallback) tests. Run: tsx tests/messagingChannel.test.ts
import assert from 'node:assert';
import { buildProactiveParams } from '../src/lib/twilio';

let passed = 0;
async function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

const froms = { whatsappFrom: 'whatsapp:+14155238886', smsFrom: '+27600151104' };

(async () => {
  console.log('messaging channel routing');

  await test('SMS channel strips whatsapp: prefix and sends plain body', () => {
    const p = buildProactiveParams('sms', 'whatsapp:+27821110001', { fallbackBody: 'Your appt is tomorrow' }, froms)!;
    assert.equal(p.from, '+27600151104');
    assert.equal(p.to, '+27821110001');
    assert.equal(p.body, 'Your appt is tomorrow');
    assert.ok(!p.contentSid, 'SMS must not use a WhatsApp template');
  });

  await test('SMS ignores WhatsApp template, still sends fallback text', () => {
    const p = buildProactiveParams('sms', '+27821110002', { contentSid: 'HX123', variables: { '1': 'x' }, fallbackBody: 'Reminder text' }, froms)!;
    assert.equal(p.body, 'Reminder text');
    assert.ok(!p.contentSid);
  });

  await test('SMS with no smsFrom configured returns null (caller logs/skips)', () => {
    const p = buildProactiveParams('sms', '+27821110003', { fallbackBody: 'x' }, { whatsappFrom: froms.whatsappFrom });
    assert.equal(p, null);
  });

  await test('WhatsApp channel uses the template when contentSid present', () => {
    const p = buildProactiveParams('whatsapp', 'whatsapp:+27821110004', { contentSid: 'HXabc', variables: { '1': 'Sarah' }, fallbackBody: 'fb' }, froms)!;
    assert.equal(p.from, 'whatsapp:+14155238886');
    assert.equal(p.contentSid, 'HXabc');
    assert.equal(p.contentVariables, JSON.stringify({ '1': 'Sarah' }));
  });

  await test('WhatsApp channel falls back to free text without a template', () => {
    const p = buildProactiveParams('whatsapp', 'whatsapp:+27821110005', { fallbackBody: 'hello' }, froms)!;
    assert.equal(p.body, 'hello');
    assert.ok(!p.contentSid);
  });

  console.log(`\n${passed} messaging-channel tests passed ✅`);
})();
