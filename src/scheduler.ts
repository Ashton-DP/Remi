/**
 * Reminder scheduler — run with: npm run scheduler
 * Polls every 60 seconds for due reminders and sends WhatsApp messages.
 */
import { config } from './config'; // also loads dotenv
import { getDueReminders, markReminderSent, getClinic, getLapsedClients, markReactivated } from './db';
import { sendProactiveWhatsApp } from './lib/twilio';
import { generateReport } from './report';

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
      case 'aftercare':
        msg = `Hi ${name} 💛 Hope your ${svc} went well today! If you have any questions or anything doesn't feel right, just reply here — we're happy to help.`;
        break;
      case 'review': {
        const url = booking.clinics?.google_review_url;
        if (!url) { await markReminderSent(r.id); continue; } // no review link configured → skip
        const clinicName = booking.clinics?.name ?? 'us';
        msg = `Hi ${name} 🌟 Thanks so much for visiting ${clinicName}! If you have a moment, a quick Google review really helps us: ${url}`;
        break;
      }
      default:
        msg = `Reminder: ${svc} on ${when}.`;
    }

    await sendProactiveWhatsApp(client.phone, { contentSid, variables, fallbackBody: msg });
    await markReminderSent(r.id);
    console.log(`[scheduler] sent ${r.kind} reminder → ${client.phone}`);
  }
}

// ---- Daily jobs: owner summary + reactivation (run once/day after DAILY_HOUR) ----
const DAILY_HOUR = parseInt(process.env.DAILY_JOBS_HOUR ?? '18', 10);
let _lastDailyDate = '';

function clinicNow(tz = 'Africa/Johannesburg') {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const hour = parseInt(now.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }), 10);
  return { dateStr, hour };
}

async function ownerSummary(clinicId: string) {
  const clinic = await getClinic(clinicId);
  const to = clinic?.owner_summary_phone || clinic?.escalation_contact;
  if (!to) return;
  const report = await generateReport(clinicId, 1);
  await sendProactiveWhatsApp(to, { fallbackBody: `📊 Your Remi daily summary:\n\n${report}` });
  console.log('[scheduler] owner summary sent');
}

async function reactivation(clinicId: string) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;
  const days = clinic.reactivation_days ?? 90;
  const lapsed = await getLapsedClients(clinicId, days);
  for (const c of lapsed as any[]) {
    if (!c.phone) continue;
    await sendProactiveWhatsApp(c.phone, {
      fallbackBody: `Hi ${c.name ?? 'there'} 👋 It's been a while since your last visit to ${clinic.name}. We'd love to see you again — just reply here and I'll find a time that suits you.`,
    });
    await markReactivated(c.id);
  }
  if (lapsed.length) console.log(`[scheduler] reactivation: ${lapsed.length} recall(s) sent`);
}

async function maybeRunDailyJobs() {
  if (!config.defaultClinicId) return;
  const { dateStr, hour } = clinicNow();
  if (dateStr === _lastDailyDate || hour < DAILY_HOUR) return;
  _lastDailyDate = dateStr;
  console.log('[scheduler] running daily jobs for', dateStr);
  await ownerSummary(config.defaultClinicId).catch((e) => console.error('[ownerSummary]', e));
  await reactivation(config.defaultClinicId).catch((e) => console.error('[reactivation]', e));
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
    maybeRunDailyJobs().catch((e) => console.error('[scheduler] daily jobs error:', e));
  }, 60_000);
}

// Run standalone when invoked directly (e.g. a dedicated Render worker).
if (require.main === module) startScheduler();
