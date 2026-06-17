/**
 * Local terminal chat with Remi — exercises the real brain + Supabase + calendar
 * path without Twilio or a tunnel. Run with: npm run chat
 *
 * Needs (in .env): the AI provider key (GEMINI_API_KEY or ANTHROPIC_API_KEY),
 * SUPABASE_URL + SUPABASE_SERVICE_KEY, and DEFAULT_CLINIC_ID (from db/seed.sql).
 */
import * as readline from 'node:readline';
import { config } from './config';
import { supabase } from './lib/supabase';
import { getClinic, getOrCreateClient, saveMessage, getHistory } from './db';
import { runAgent } from './brain/agent';

const TEST_PHONE = 'whatsapp:+27820000001';

async function main() {
  if (!config.defaultClinicId) {
    console.error('✗ Set DEFAULT_CLINIC_ID in .env first (run db/seed.sql to get it).');
    process.exit(1);
  }

  const clinic = await getClinic(config.defaultClinicId);
  if (!clinic) {
    console.error('✗ Clinic not found. Did you run db/schema.sql + db/seed.sql and set DEFAULT_CLINIC_ID?');
    process.exit(1);
  }

  const { client: customer } = await getOrCreateClient(clinic.id, TEST_PHONE);

  // Fresh conversation each run so every session starts clean.
  const { data: convo, error } = await supabase
    .from('conversations')
    .insert({
      clinic_id: clinic.id,
      client_id: customer.id,
      channel: 'whatsapp',
      status: 'open',
      last_message_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error || !convo) {
    console.error('✗ Could not create conversation:', error?.message);
    process.exit(1);
  }

  const modelLabel = config.aiProvider === 'gemini' ? config.gemini.model : config.model;
  console.log(`\n💬 Remi test chat — provider: ${config.aiProvider} (${modelLabel})`);
  console.log(`   Clinic: ${clinic.name}`);
  console.log(`   Type a message, or "exit" to quit.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let firstContact = true;
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  const ask = () => {
    if (closed) return;
    rl.question('you  › ', async (line) => {
      const text = line.trim();
      if (!text) return ask();
      if (text.toLowerCase() === 'exit') return rl.close();
      try {
        await saveMessage(convo.id, 'in', text);
        const history = await getHistory(convo.id);
        const reply = await runAgent(clinic, customer, convo, history, firstContact);
        firstContact = false;
        await saveMessage(convo.id, 'out', reply);
        console.log(`\nremi › ${reply}\n`);
      } catch (e) {
        console.error('error:', e);
      }
      ask();
    });
  };
  ask();
}

main();
