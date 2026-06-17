/**
 * Reminder scheduler — run with: npm run scheduler
 * Polls every 60 seconds for due reminders and sends WhatsApp messages.
 */
import './config'; // loads dotenv
import { getDueReminders, markReminderSent } from './db';
import { sendWhatsApp } from './lib/twilio';

function formatWhen(startAt: string, timezone: string): string {
  return new Date(startAt).toLocaleString('en-ZA', {
    timeZone: timezone ?? 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function tick() {
  const reminders = await getDueReminders();
  if (reminders.length) console.log(`[scheduler] ${reminders.length} due reminder(s)`);

  for (const r of reminders as any[]) {
    const booking = r.bookings;
    if (!booking || booking.status === 'cancelled') {
      await markReminderSent(r.id);
      continue;
    }
    const client = booking.clients;
    if (!client?.phone) {
      await markReminderSent(r.id);
      continue;
    }

    const when = formatWhen(booking.start_at, 'Africa/Johannesburg');
    const name = client.name ?? 'there';
    const svc = booking.service;

    let msg: string;
    switch (r.kind) {
      case '48h':
        msg = `Hi ${name} 👋 Friendly reminder: you have ${svc} booked for ${when}. Reply CONFIRM to lock it in or CANCEL if your plans changed.`;
        break;
      case '24h':
        msg = `Your ${svc} is tomorrow at ${when}. Reply CONFIRM to confirm or RESCHEDULE if you need a different time.`;
        break;
      case '2h':
        msg = `See you soon! Your ${svc} starts in about 2 hours (${when}). We can't wait 😊`;
        break;
      default:
        msg = `Reminder: ${svc} on ${when}.`;
    }

    await sendWhatsApp(client.phone, msg);
    await markReminderSent(r.id);
    console.log(`[scheduler] sent ${r.kind} reminder → ${client.phone}`);
  }
}

async function run() {
  console.log('[scheduler] started — checking every 60s');
  await tick().catch((e) => console.error('[scheduler] tick error:', e));
  setInterval(() => {
    tick().catch((e) => console.error('[scheduler] tick error:', e));
  }, 60_000);
}

run();
