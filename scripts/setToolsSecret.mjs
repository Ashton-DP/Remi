// Add the X-Tool-Secret header to the EXISTING ElevenLabs agent tools so the
// agent authenticates to our /tools/* webhooks. PATCHes in place (does NOT create
// duplicates like setupAgentTools.mjs would).
// Run: node --env-file=.env scripts/setToolsSecret.mjs
// Requires ELEVENLABS_API_KEY and TOOLS_SHARED_SECRET in .env — the secret MUST
// match the TOOLS_SHARED_SECRET set on Railway, or the server will 403 the agent.
const API_KEY = process.env.ELEVENLABS_API_KEY;
const SECRET = process.env.TOOLS_SHARED_SECRET;
if (!API_KEY) { console.error('Missing ELEVENLABS_API_KEY'); process.exit(1); }
if (!SECRET) { console.error('Missing TOOLS_SHARED_SECRET (add it to .env, same value as Railway)'); process.exit(1); }

const H = { 'xi-api-key': API_KEY, 'content-type': 'application/json' };
const TARGETS = ['check_availability', 'create_booking', 'reschedule_booking', 'cancel_booking', 'add_to_waitlist', 'get_services'];

async function main() {
  const listRes = await fetch('https://api.elevenlabs.io/v1/convai/tools', { headers: H });
  if (!listRes.ok) throw new Error('list tools failed ' + listRes.status + ' ' + (await listRes.text()));
  const list = await listRes.json();
  const tools = list.tools || list || [];

  for (const t of tools) {
    const id = t.id || t.tool_id;
    const name = (t.tool_config || t)?.name;
    if (!TARGETS.includes(name)) continue;

    // GET the full tool to patch its real config.
    const gr = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, { headers: H });
    if (!gr.ok) { console.log(`  ✗ ${name}: GET ${gr.status}`); continue; }
    const full = await gr.json();
    const tc = full.tool_config || full;
    if (!tc?.api_schema) { console.log(`  - ${name}: no api_schema, skipped`); continue; }

    // Merge the secret header, preserving any existing headers.
    tc.api_schema.request_headers = { ...(tc.api_schema.request_headers || {}), 'X-Tool-Secret': SECRET };

    const pr = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ tool_config: tc }),
    });
    const ptxt = await pr.text();
    if (!pr.ok) { console.log(`  ✗ ${name}: PATCH ${pr.status} ${ptxt.slice(0, 200)}`); continue; }

    // Verify.
    const vr = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, { headers: H });
    const v = await vr.json();
    const hdrs = (v.tool_config || v)?.api_schema?.request_headers || {};
    const ok = Object.keys(hdrs).some((k) => k.toLowerCase() === 'x-tool-secret');
    console.log(`  ${ok ? '✓' : '✗'} ${name}: X-Tool-Secret ${ok ? 'set' : 'NOT set'}`);
  }
  console.log('\nDone. The agent now sends X-Tool-Secret. Re-publish the agent if a change does not take.');
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
