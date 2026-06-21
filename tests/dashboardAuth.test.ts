// Dashboard auth tests. Run: node_modules/.bin/tsx tests/dashboardAuth.test.ts
// The token must be set BEFORE config is imported. Static ESM imports are hoisted
// and run first, so config/dashboardAuth are loaded via dynamic import below,
// after we set the env var.
import assert from 'node:assert';

process.env.DASHBOARD_TOKEN = 'secret-master-token';

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

// Minimal Express req/res doubles.
function mkRes() {
  return {
    statusCode: 200,
    body: '',
    cookies: {} as Record<string, any>,
    status(c: number) { this.statusCode = c; return this; },
    type() { return this; },
    send(b: string) { this.body = b; return this; },
    cookie(k: string, v: string, o: any) { this.cookies[k] = { v, o }; return this; },
  };
}
function mkReq(over: any = {}) {
  return { query: {}, params: {}, headers: {}, protocol: 'https', ...over } as any;
}

(async () => {
  // Dynamic import AFTER the env var is set (config reads env at import time).
  const { config } = await import('../src/config');
  const { requireDashboardAuth, qp } = await import('../src/lib/dashboardAuth');

  // Bind the doubles' runner to the freshly-imported middleware.
  async function run(req: any) {
    const res = mkRes();
    let nexted = false;
    await requireDashboardAuth(req, res as any, () => { nexted = true; });
    return { res, nexted };
  }

  console.log('dashboard auth gate');

  await test('qp coerces query/param shapes', () => {
    assert.equal(qp('a'), 'a');
    assert.equal(qp(['a', 'b']), 'a');
    assert.equal(qp(undefined), undefined);
    assert.equal(qp(123 as any), undefined);
  });

  await test('no token supplied → 401, not allowed', async () => {
    const { res, nexted } = await run(mkReq());
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  await test('wrong token → 403, not allowed', async () => {
    const { res, nexted } = await run(mkReq({ query: { token: 'nope' } }));
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });

  await test('correct master token → passes + sets HttpOnly cookie', async () => {
    const { res, nexted } = await run(mkReq({ query: { token: 'secret-master-token' } }));
    assert.equal(nexted, true);
    assert.equal(res.cookies.remi_dash?.v, 'secret-master-token');
    assert.equal(res.cookies.remi_dash?.o?.httpOnly, true);
  });

  await test('valid token via cookie → passes (no new cookie set)', async () => {
    const { res, nexted } = await run(mkReq({ headers: { cookie: 'remi_dash=secret-master-token' } }));
    assert.equal(nexted, true);
    assert.equal(res.cookies.remi_dash, undefined);
  });

  await test('FAIL-CLOSED: no DASHBOARD_TOKEN configured → 503, not allowed', async () => {
    const saved = config.dashboard.token;
    config.dashboard.token = '';
    try {
      const { res, nexted } = await run(mkReq({ query: { token: 'anything' } }));
      assert.equal(nexted, false);
      assert.equal(res.statusCode, 503);
    } finally {
      config.dashboard.token = saved;
    }
  });

  console.log(`\n${passed} dashboard-auth tests passed ✅`);
})();
