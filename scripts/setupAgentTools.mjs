// Creates Remi's booking webhook tools on the ElevenLabs agent and attaches them.
// Run: node --env-file=.env scripts/setupAgentTools.mjs
// Requires ELEVENLABS_API_KEY in .env. Idempotent-ish: re-running creates new
// tool copies (ElevenLabs has no upsert), so only run once (or delete dupes in UI).

const API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.REMI_AGENT_ID || 'agent_0401kvgbefsge65rec78ma1gj4k7';
const BASE = process.env.REMI_TOOLS_BASE || 'https://www.remireception.com/tools';
const SECRET = process.env.TOOLS_SHARED_SECRET || '';

if (!API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY in .env');
  process.exit(1);
}

const H = { 'xi-api-key': API_KEY, 'content-type': 'application/json' };

const TOOLS = [
  {
    name: 'check_availability',
    description: 'Get open appointment times for a service on a date. Call this when the caller names a day they want to come in.',
    params: {
      date: { desc: "The date the caller wants, format YYYY-MM-DD. Work it out from today's date.", required: true },
      service: { desc: 'The treatment name, e.g. Botox treatment, Dermal filler.', required: true },
    },
  },
  {
    name: 'create_booking',
    description: 'Book the appointment. Only call AFTER the caller confirms a specific time you offered.',
    params: {
      service: { desc: 'The treatment name.', required: true },
      start_at: { desc: 'Exact time copied from one of the available_slots from check_availability (full ISO, e.g. 2026-06-20T09:00:00+02:00).', required: true },
      client_name: { desc: "The caller's full name.", required: true },
      caller_phone: { desc: "The caller's phone number (ask for it if you don't have it).", required: true },
    },
  },
  {
    name: 'reschedule_booking',
    description: "Move the caller's upcoming appointment to a new time. Call check_availability first to find a new slot.",
    params: {
      new_start_at: { desc: 'New time, ISO format from check_availability.', required: true },
      caller_phone: { desc: "The caller's phone number.", required: true },
    },
  },
  {
    name: 'cancel_booking',
    description: "Cancel the caller's upcoming appointment. Frees the slot and offers it to the waitlist.",
    params: {
      caller_phone: { desc: "The caller's phone number.", required: true },
    },
  },
  {
    name: 'add_to_waitlist',
    description: 'Add the caller to the waitlist when no slots are available; they are texted when one opens.',
    params: {
      service: { desc: 'The treatment name.', required: true },
      preferred_window: { desc: 'Preferred time window, e.g. weekday mornings (optional).', required: false },
      caller_phone: { desc: "The caller's phone number.", required: true },
    },
  },
];

function bodySchema(params) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params)) {
    properties[k] = { type: 'string', description: v.desc };
    if (v.required) required.push(k);
  }
  return { type: 'object', properties, required };
}

async function createTool(t) {
  const api_schema = {
    url: `${BASE}/${t.name}`,
    method: 'POST',
    request_body_schema: bodySchema(t.params),
  };
  if (SECRET) api_schema.request_headers = { 'X-Tool-Secret': SECRET };
  const body = {
    tool_config: {
      type: 'webhook',
      name: t.name,
      description: t.description,
      response_timeout_secs: 20,
      api_schema,
    },
  };
  const res = await fetch('https://api.elevenlabs.io/v1/convai/tools', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create ${t.name} failed ${res.status}: ${text}`);
  const json = JSON.parse(text);
  const id = json.id || json.tool_id || json.tool?.id;
  console.log(`  ✓ created ${t.name} → ${id}`);
  return id;
}

async function main() {
  console.log('Creating tools…');
  const ids = [];
  for (const t of TOOLS) ids.push(await createTool(t));

  console.log('\nFetching agent to attach tools…');
  const getRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`, { headers: H });
  if (!getRes.ok) throw new Error(`get agent failed ${getRes.status}: ${await getRes.text()}`);
  const agent = await getRes.json();
  const prompt = agent?.conversation_config?.agent?.prompt ?? {};
  const existing = prompt.tool_ids ?? [];
  const merged = Array.from(new Set([...existing, ...ids]));
  console.log(`  existing tool_ids: ${existing.length}, after merge: ${merged.length}`);

  const patchRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ conversation_config: { agent: { prompt: { tool_ids: merged } } } }),
  });
  const patchText = await patchRes.text();
  if (!patchRes.ok) {
    console.error(`\n⚠️ Attach (PATCH) failed ${patchRes.status}: ${patchText}`);
    console.error('Tools were CREATED though — you can attach them in the agent UI (Tools → add existing).');
    process.exit(2);
  }
  console.log('\n✅ Done — tools created and attached to the agent.');
}

main().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
