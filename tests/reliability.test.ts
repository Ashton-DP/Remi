// Reliability tests (idempotency + AI fallback). Run: tsx tests/reliability.test.ts
import assert from 'node:assert';
import { aiFallbackMessage } from '../src/brain/agent';
import { redactPII } from '../src/lib/monitoring';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exit(1);
  }
}

(async () => {
  console.log('AI fallback');

  await test('voice fallback is speakable (no emoji/markup)', () => {
    const msg = aiFallbackMessage(true);
    assert.ok(msg.length > 0);
    assert.ok(!/[🙏💛🌟👋📊]/u.test(msg), 'voice message should have no emoji');
    assert.ok(/team member/i.test(msg));
  });

  await test('text fallback reassures + signals human follow-up', () => {
    const msg = aiFallbackMessage(false);
    assert.ok(/team|someone/i.test(msg));
    assert.ok(msg !== aiFallbackMessage(true), 'voice and text variants should differ');
  });

  console.log('PII redaction for external alerts');

  await test('masks a phone number to last 4 digits', () => {
    const out = redactPII('error for whatsapp:+27821234567 booking');
    assert.ok(!out.includes('27821234567'), `phone not masked: ${out}`);
    assert.ok(out.includes('4567'), `last-4 missing: ${out}`);
  });

  await test('masks plain international numbers', () => {
    const out = redactPII('context: {"from":"+27 82 123 4567"}');
    assert.ok(!out.includes('123 4567'), out);
    assert.ok(out.includes('4567'), out);
  });

  await test('leaves non-phone text intact', () => {
    assert.equal(redactPII('AI provider gemini failed: 429'), 'AI provider gemini failed: 429');
  });

  console.log(`\n${passed} reliability tests passed ✅`);
})();
