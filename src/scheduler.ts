/**
 * Reminder scheduler — run with: npm run scheduler
 * Polls every 60 seconds for due reminders and sends WhatsApp messages.
 */
import { config } from './config'; // also loads dotenv
import { getDueReminders, markReminderSent } from './db';
import { sendProactiveWhatsApp } from './lib/twilio';

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
    let contentSid: string | undefined;
    let variables: Record<string, string> = {};
    switch (r.kind) {
      case '48h':
        msg = `Hi ${name} 👋 Friendly reminder: you have ${svc} booked for ${when}. Reply CONFIRM to lock it in or CANCEL if your plans changed.`;
        contentSid = config.templates.reminder48h || undefined;
        variables = { '1': name, '2': svc, '3': when };
        break;
      case '24h':
        msg = `Your ${svc} is tomorrow at ${when}. Reply CONFIRM to confirm or RESCHEDULE if you need a different time.`;
        contentSid = config.templates.reminder24h || undefined;
        variables = { '1': svc, '2': when };
        break;
      case '2h':
        msg = `See you soon! Your ${svc} starts in about 2 hours (${when}). We can't wait 😊`;
        contentSid = config.templates.reminder2h || undefined;
        variables = { '1': svc, '2': when };
        break;
      default:
        msg = `Reminder: ${svc} on ${when}.`;
    }

    await sendProactiveWhatsApp(client.phone, { contentSid, variables, fallbackBody: msg });
    await markReminderSent(r.id);
    console.log(`[scheduler] sent ${r.kind} reminder → ${client.phone}`);
  }
}

let _started = false;

/**
 * Start the reminder poll loop. Safe to call from inside the web process
 * (single instance) or from a standalone worker. Idempotent.
 *
 * NOTE: if you ever scale the web service to multiple instances, run the
 * scheduler as ONE dedicated worker instead (set RUN_SCHEDULER=false on web)
 * to avoid duplicate reminder sends.
 */
export function startScheduler() {
  if (_started) return;
  _started = true;
  console.log('[scheduler] started — checking every 60s');
  tick().catch((e) => console.error('[scheduler] tick error:', e));
  setInterval(() => {
    tick().catch((e) => console.error('[scheduler] tick error:', e));
  }, 60_000);
}

// Run standalone when invoked directly (e.g. a dedicated Render worker).
if (require.main === module) startScheduler();
