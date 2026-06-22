// Rate limiter tests. Run: tsx tests/rateLimit.test.ts
import assert from 'node:assert';
import { rateLimit } from '../src/lib/rateLimit';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

function mkRes() {
  return {
    statusCode: 0, body: '', headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    type() { return this; },
    send(b: string) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
}
function run(mw: any, ip: string) {
  const res = mkRes();
  let nexted = false;
  mw({ ip } as any, res as any, () => { nexted = true; });
  return { res, nexted };
}

(async () => {
  console.log('rate limiter');

  await test('allows up to max, blocks the next with 429 + Retry-After', () => {
    const mw = rateLimit({ name: 't', windowMs: 60_000, max: 2 });
    assert.equal(run(mw, '1.1.1.1').nexted, true);   // 1
    assert.equal(run(mw, '1.1.1.1').nexted, true);   // 2
    const third = run(mw, '1.1.1.1');                // 3 → blocked
    assert.equal(third.nexted, false);
    assert.equal(third.res.statusCode, 429);
    assert.ok(third.res.headers['Retry-After'], 'sets Retry-After');
  });

  await test('limits are per-key (per IP)', () => {
    const mw = rateLimit({ name: 't2', windowMs: 60_000, max: 1 });
    assert.equal(run(mw, '2.2.2.2').nexted, true);   // ip A ok
    assert.equal(run(mw, '2.2.2.2').nexted, false);  // ip A blocked
    assert.equal(run(mw, '3.3.3.3').nexted, true);   // ip B unaffected
  });

  console.log(`\n${passed} rate-limit tests passed ✅`);
})();
