// Prints the live Meta-approval status of every WhatsApp template Content SID.
// Usage:  node --env-file=.env scripts/checkTemplates.mjs
//   (or)  npm run check:templates
//
// Needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN in the env. Read-only — it only
// queries Twilio's Content API, never creates or submits anything.

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOKEN) {
  console.error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. Run with: node --env-file=.env scripts/checkTemplates.mjs');
  process.exit(1);
}

// The currently-submitted templates (the *_v2 replacements supersede the two that
// Meta rejected for ending on a variable). Keep this list in sync with
// docs/whatsapp-templates.md when SIDs change.
const TEMPLATES = [
  { name: 'appointment_reminder_48h', env: 'WA_TEMPLATE_REMINDER_48H', sid: 'HX43001f0a31c1c9863db65c55df4ae5bb' },
  { name: 'appointment_reminder_24h', env: 'WA_TEMPLATE_REMINDER_24H', sid: 'HXf6f911684827eaa8e920f5ac63f2b66f' },
  { name: 'appointment_reminder_2h',  env: 'WA_TEMPLATE_REMINDER_2H',  sid: 'HXdbf60657a72f12f04f12052fe08369e3' },
  { name: 'waitlist_slot_offer',      env: 'WA_TEMPLATE_WAITLIST_OFFER', sid: 'HX9469a351b614c835750270cefd00b969' },
  { name: 'missed_call_text_back',    env: 'WA_TEMPLATE_MISSED_CALL',  sid: 'HX52c52583073f84c30254060f458674ec' },
  { name: 'aftercare_check_in',       env: 'WA_TEMPLATE_AFTERCARE',    sid: 'HXf3422c2e2edeff72f932fd0b7568a02d' },
  { name: 'reactivation_winback',     env: 'WA_TEMPLATE_REACTIVATION', sid: 'HX993c49331463e7946049cd5b2e35c56c' },
  { name: 'review_request_v2',        env: 'WA_TEMPLATE_REVIEW',       sid: 'HX5c26c95050812859b02b44be0a363ed8' },
  { name: 'deposit_request_v2',       env: 'WA_TEMPLATE_DEPOSIT',      sid: 'HX1ef2062e9bccaece480d32711ebe075c' },
];

const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const ICON = { approved: '🟢', pending: '🟡', received: '🟡', rejected: '🔴', unsubmitted: '⚪' };

async function statusOf(sid) {
  try {
    const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, { headers: { Authorization: auth } });
    if (!res.ok) return { status: `http_${res.status}` };
    const d = await res.json();
    const w = d.whatsapp || {};
    return { status: w.status || 'unknown', reason: w.rejection_reason || '' };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

const main = async () => {
  console.log('\nWhatsApp template approval status (live from Twilio/Meta)\n');
  const counts = {};
  for (const t of TEMPLATES) {
    const { status, reason } = await statusOf(t.sid);
    counts[status] = (counts[status] || 0) + 1;
    const live = process.env[t.env] ? '  (env set ✓)' : '';
    const icon = ICON[status] || '•';
    console.log(`${icon} ${status.padEnd(10)} ${t.name.padEnd(26)} ${t.sid.slice(0, 12)}…${live}`);
    if (reason) console.log(`             ↳ ${reason}`);
  }
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`\n${summary}`);
  const approved = counts.approved || 0;
  console.log(approved === TEMPLATES.length
    ? '\n✅ All approved — paste each SID into its env var (.env + Railway) and redeploy.'
    : `\n⏳ ${approved}/${TEMPLATES.length} approved. Re-run later; paste approved SIDs into their env vars as they clear.\n`);
};

main();
