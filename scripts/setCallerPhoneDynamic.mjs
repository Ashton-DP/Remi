// Update the booking tools so caller_phone is auto-filled from the real caller's
// number (ElevenLabs system variable system__caller_id) instead of being asked by
// the LLM. Run: node --env-file=.env scripts/setCallerPhoneDynamic.mjs
const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) { console.error('Missing ELEVENLABS_API_KEY'); process.exit(1); }
const H = { 'xi-api-key': API_KEY, 'content-type': 'application/json' };
const TARGETS = ['create_booking', 'reschedule_booking', 'cancel_booking', 'add_to_waitlist'];

async function main() {
  const listRes = await fetch('https://api.elevenlabs.io/v1/convai/tools', { headers: H });
  if (!listRes.ok) throw new Error('list tools failed ' + listRes.status + ' ' + (await listRes.text()));
  const list = await listRes.json();
  const tools = list.tools || list || [];

  for (const t of tools) {
    const id = t.id || t.tool_id;
    const cfg = t.tool_config || t;
    const name = cfg?.name;
    if (!TARGETS.includes(name)) continue;

    // GET full tool to be safe
    const gr = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, { headers: H });
    const full = await gr.json();
    const tc = full.tool_config || full;
    const body = tc?.api_schema?.request_body_schema;
    const prop = body?.properties?.caller_phone;
    if (!prop) { console.log(`  - ${name}: no caller_phone prop, skipped`); continue; }

    // Set the value source to the system caller-id dynamic variable, and stop
    // requiring the LLM to provide it.
    // A param may set only ONE of description / dynamic_variable / constant_value.
    delete prop.description;
    delete prop.constant_value;
    prop.dynamic_variable = 'system__caller_id';
    if (Array.isArray(body.required)) body.required = body.required.filter((r) => r !== 'caller_phone');

    const pr = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ tool_config: tc }),
    });
    const ptxt = await pr.text();
    if (!pr.ok) { console.log(`  ✗ ${name}: PATCH ${pr.status} ${ptxt.slice(0, 200)}`); continue; }

    // verify
    const vr = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, { headers: H });
    const v = await vr.json();
    const vp = (v.tool_config || v)?.api_schema?.request_body_schema?.properties?.caller_phone;
    console.log(`  ✓ ${name}: caller_phone.dynamic_variable = ${vp?.dynamic_variable ?? '(not set!)'}`);
  }
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
