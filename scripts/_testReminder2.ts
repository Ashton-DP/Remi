import * as fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
const envPath = new URL('../.env', import.meta.url).pathname;
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) { const m=line.match(/^([A-Z_]+)=(.*)$/); if(m)process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); }
const sb=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_KEY!);
const tw=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const CLIENT='afc729c2-4450-416c-af7a-eb329556418f', CLINIC='3ca14bd5-0990-4589-be4c-1a1327d99bb3';
async function main(){
  const now=Date.now();
  const { data: bk } = await sb.from('bookings').insert({
    clinic_id:CLINIC, client_id:CLIENT, service:'TEST reminder (please ignore)',
    start_at:new Date(now+2*3600_000).toISOString(), end_at:new Date(now+2.5*3600_000).toISOString(),
    status:'confirmed', source:'reminder-test', calendar_event_id:'reminder-test',
  }).select('id').single();
  const { data: rem } = await sb.from('reminders').insert({
    booking_id:bk!.id, kind:'2h', scheduled_for:new Date(now-60_000).toISOString(), status:'pending',
  }).select('id').single();
  console.log('booking', bk!.id, '| reminder', rem!.id, '\nwaiting for status=sent (not interrupting)...');
  let final='pending';
  for(let i=0;i<18;i++){
    await sleep(10000);
    const { data:r } = await sb.from('reminders').select('status').eq('id',rem!.id).single();
    console.log(`  +${(i+1)*10}s → ${r?.status}`);
    if(r?.status==='sent'){ final='sent'; break; }
  }
  await sleep(3000);
  const msgs = await tw.messages.list({ to:'whatsapp:+447826441164', limit:3 });
  console.log('\nMost recent messages to test phone:');
  for(const m of msgs) console.log(`  ${m.dateCreated} status=${m.status} err=${m.errorCode??'none'} | "${(m.body??'').slice(0,80)}"`);
  await sb.from('reminders').delete().eq('id',rem!.id);
  await sb.from('bookings').delete().eq('id',bk!.id);
  console.log('\ncleaned up. reminder final status:', final);
}
main().catch(e=>console.error('THREW',e.message));
