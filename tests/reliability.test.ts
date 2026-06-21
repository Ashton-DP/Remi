// Reliability tests (idempotency + AI fallback). Run: tsx tests/reliability.test.ts
import assert from 'node:assert';
import { aiFallbackMessage } from '../src/brain/agent';

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

  console.log(`\n${passed} reliability tests passed ✅`);
})();
