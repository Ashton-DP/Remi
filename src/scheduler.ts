/**
 * Reminder scheduler — run with: npm run scheduler
 * Polls every 60 seconds for due reminders and sends WhatsApp messages.
 */
import { config } from './config'; // also loads dotenv
import { getDueReminders, markReminderSent, claimReminder, getClinic, getLapsedClients, markReactivated, purgeExpiredData, getReportData, getStaleOpenConversations, markFollowupSent, getTodaysBookings, getBookingsForDate, getClinicsWithSummaryPhone, getClinicIdsWithOverdueInvoices } from './db';
import { sendProactiveWhatsApp } from './lib/twilio';
import { runChaseForClinic } from './lib/chaseRunner';
import { syncInvoicesForClinic } from './lib/invoiceSources';
import { getClinicsWithInvoiceSource, getClinicsWithPendingEmailDomain, updateClinicEmailDomainStatus, getChaseableInvoices, getOpenEscalations } from './db';
import { verifyDomain, getDomain } from './lib/resendDomains';
import { generateReport, computeReportStats, buildMorningBrief, buildEveningBrief } from './report';

function formatWhen(startAt: string, timezone: string): string {
  return new Date(startAt).toLocaleString('en-ZA', {
    timeZone: timezone ?? 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

let _ticking = false;

async function tick() {
  // setInterval doesn't wait for the async callback — guard against a slow tick
  // overlapping the next one (which would re-process the same not-yet-marked rows).
  if (_ticking) {
    console.warn('[scheduler] previous tick still running — skipping this cycle');
    return;
  }
  _ticking = true;
  try {
    await _tick();
  } finally {
    _ticking = false;
  }
}

/** One-time "still keen?" nudge to enquiries that didn't book. OFF by default —
 *  enable with FOLLOWUP_ENABLED=true (auto-outreach should be a deliberate choice). */
async function processFollowups() {
  if (process.env.FOLLOWUP_ENABLED !== 'true') return;
  const min = parseInt(process.env.FOLLOWUP_MIN_HOURS ?? '3', 10);
  const max = parseInt(process.env.FOLLOWUP_MAX_HOURS ?? '72', 10);
  const convos = await getStaleOpenConversations(min, max);
  for (const c of convos as any[]) {
    const client = c.clients;
    await markFollowupSent(c.id); // claim before send so we never double-chase
    if (!client?.phone) continue;
    const name = client.name ?? 'there';
    const clinicName = c.clinics?.name ?? 'us';
    await sendProactiveWhatsApp(client.phone, {
      fallbackBody: `Hi ${name} 👋 Just checking in from ${clinicName} — still keen to get booked in? Reply here and I'll find a time that suits you.`,
    });
  }
  if (convos.length) console.log(`[scheduler] ${convos.length} enquiry follow-up(s) sent`);
}

async function _tick() {
  await processFollowups().catch((e) => console.error('[followups]', e));
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
        contentSid = config.templates.aftercare || undefined;
        variables = { '1': name, '2': svc };
        break;
      case 'review': {
        const url = booking.clinics?.google_review_url;
        if (!url) { await markReminderSent(r.id); continue; } // no review link configured → skip
        const clinicName = booking.clinics?.name ?? 'us';
        msg = `Hi ${name} 🌟 Thanks so much for visiting ${clinicName}! If you have a moment, a quick Google review really helps us: ${url}`;
        contentSid = config.templates.review || undefined;
        variables = { '1': name, '2': clinicName, '3': url };
        break;
      }
      default:
        msg = `Reminder: ${svc} on ${when}.`;
    }

    // Atomically claim (pending→sending) so a crash/retry or a second instance
    // can't send the same reminder twice. If we don't win the claim, skip.
    if (!(await claimReminder(r.id))) continue;
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

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://www.remireception.com';
let _lastMonthlyKey = '';

/** Once a month, send the owner the headline "revenue recovered" + a link to the
 *  branded report. This is the anti-churn artifact. */
async function monthlyReport(clinicId: string) {
  const clinic = await getClinic(clinicId);
  const to = clinic?.owner_summary_phone || clinic?.escalation_contact;
  if (!to) return;
  const sinceISO = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { events, bookings } = await getReportData(clinicId, sinceISO);
  const s = computeReportStats(events as any[], bookings as any[]);
  const R = (n: number) => 'R' + n.toLocaleString('en-ZA');
  const link = clinic.dashboard_token
    ? `${PUBLIC_BASE}/report/${clinicId}?token=${encodeURIComponent(clinic.dashboard_token)}`
    : '';
  const body =
    `📊 Your Remi report — last 30 days\n\n` +
    `Remi captured ${R(s.bookedR)} across ${s.bookedN} booking(s)` +
    (s.recoveredR > 0 ? `, incl. ${R(s.recoveredR)} recovered from missed calls & cancellations` : '') +
    `.` + (link ? `\n\nFull report: ${link}` : '');
  await sendProactiveWhatsApp(to, { fallbackBody: body });
  console.log('[scheduler] monthly report sent');
}

async function reactivation(clinicId: string) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;
  const days = clinic.reactivation_days ?? 90;
  const lapsed = await getLapsedClients(clinicId, days);
  for (const c of lapsed as any[]) {
    if (!c.phone) continue;
    const cName = c.name ?? 'there';
    await sendProactiveWhatsApp(c.phone, {
      contentSid: config.templates.reactivation || undefined,
      variables: { '1': cName, '2': clinic.name },
      fallbackBody: `Hi ${cName} 👋 It's been a while since your last visit to ${clinic.name}. We'd love to see you again — just reply here and I'll find a time that suits you.`,
    });
    await markReactivated(c.id);
  }
  if (lapsed.length) console.log(`[scheduler] reactivation: ${lapsed.length} recall(s) sent`);
}

// ---- Invoice chasing (PaidUp engine) — once per weekday on/after CHASE_HOUR ----
let _lastChaseDate = '';

/** Run the invoice chase loop once per weekday. OFF unless CHASE_ENABLED=true. */
async function maybeRunInvoiceChase() {
  if (!config.chase.enabled) return;
  const { dateStr, hour } = clinicNow();
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun 6=Sat
  if (dateStr === _lastChaseDate || hour < config.chase.hour || dow === 0 || dow === 6) return;
  _lastChaseDate = dateStr;

  // 1. Auto-sync invoices from connected accounting sources (Xero/QBO/Sage/Sheet).
  const sourceClinics = await getClinicsWithInvoiceSource().catch(() => []);
  for (const c of sourceClinics as any[]) {
    await syncInvoicesForClinic(c.id).catch((e) => console.error('[invoice-sync]', c.id, e?.message ?? e));
  }

  // 2. Chase overdue invoices. Default clinic if set, else any clinic that has
  //    overdue invoices or a connected source.
  const ids = config.defaultClinicId
    ? [config.defaultClinicId]
    : [...new Set([...(await getClinicIdsWithOverdueInvoices()), ...sourceClinics.map((c: any) => c.id)])];
  let total = 0;
  for (const id of ids) total += await runChaseForClinic(id).catch((e) => (console.error('[chase]', e), 0));
  if (total) console.log(`[scheduler] invoice chase: ${total} message(s) sent across ${ids.length} clinic(s)`);
}

const HUDDLE_HOUR = parseInt(process.env.HUDDLE_HOUR ?? '7', 10);
const EVENING_HOUR = parseInt(process.env.EVENING_BRIEF_HOUR ?? '17', 10);

// Per-clinic once-a-day guard, keyed `${clinicId}:${dateStr}:${kind}`. Cleared
// when the day rolls over so it never grows unbounded.
const _briefsSent = new Set<string>();
let _briefsDay = '';
function alreadySent(key: string, dateStr: string): boolean {
  if (dateStr !== _briefsDay) { _briefsSent.clear(); _briefsDay = dateStr; }
  if (_briefsSent.has(key)) return true;
  _briefsSent.add(key);
  return false;
}

/** Every clinic that has opted into proactive briefs (summary phone set), plus
 *  the default clinic if one is configured (so single-clinic deploys still work
 *  even when only an escalation contact is set). De-duplicated by id. */
async function briefRecipients() {
  const list = (await getClinicsWithSummaryPhone().catch(() => [])) as any[];
  const byId = new Map<string, any>(list.map((c) => [c.id, c]));
  if (config.defaultClinicId && !byId.has(config.defaultClinicId)) {
    const c = await getClinic(config.defaultClinicId).catch(() => null);
    if (c) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** Morning "here's your day" brief — today's appointments + overdue/escalation
 *  flags. Runs once each morning on/after HUDDLE_HOUR, for every opted-in clinic. */
async function maybeRunHuddle() {
  const { dateStr, hour } = clinicNow();
  if (hour < HUDDLE_HOUR) return;
  for (const clinic of await briefRecipients()) {
    const to = clinic.owner_summary_phone || clinic.escalation_contact;
    if (!to || alreadySent(`${clinic.id}:${dateStr}:morning`, dateStr)) continue;
    try {
      const tz = clinic.timezone ?? 'Africa/Johannesburg';
      const [bookings, overdue, esc] = await Promise.all([
        getTodaysBookings(clinic.id, tz),
        getChaseableInvoices(clinic.id),
        getOpenEscalations(clinic.id),
      ]);
      const overdueTotal = (overdue as any[]).reduce((sum, i) => sum + (Number(i.amount_due) || 0), 0);
      const brief = buildMorningBrief({
        clinicName: clinic.name, timeZone: tz, intakeEnabled: config.intake.enabled,
        bookings, overdueCount: (overdue as any[]).length, overdueTotalZar: overdueTotal, escalations: (esc as any[]).length,
      });
      await sendProactiveWhatsApp(to, { fallbackBody: brief });
      console.log(`[scheduler] morning brief sent → ${clinic.name}`);
    } catch (e: any) {
      console.error('[scheduler] morning brief failed', clinic.id, e?.message ?? e);
    }
  }
}

/** Evening wrap — what happened today + tomorrow's schedule + open items.
 *  Runs once each evening on/after EVENING_HOUR, for every opted-in clinic. */
async function maybeRunEveningBrief() {
  const { dateStr, hour } = clinicNow();
  if (hour < EVENING_HOUR) return;
  for (const clinic of await briefRecipients()) {
    const to = clinic.owner_summary_phone || clinic.escalation_contact;
    if (!to || alreadySent(`${clinic.id}:${dateStr}:evening`, dateStr)) continue;
    try {
      const tz = clinic.timezone ?? 'Africa/Johannesburg';
      const tomorrowStr = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });
      const [today, tomorrow, overdue, esc] = await Promise.all([
        getTodaysBookings(clinic.id, tz),
        getBookingsForDate(clinic.id, tomorrowStr, tz),
        getChaseableInvoices(clinic.id),
        getOpenEscalations(clinic.id),
      ]);
      const overdueTotal = (overdue as any[]).reduce((sum, i) => sum + (Number(i.amount_due) || 0), 0);
      const brief = buildEveningBrief({
        clinicName: clinic.name, timeZone: tz,
        todayCount: (today as any[]).length, tomorrow: tomorrow as any[],
        overdueCount: (overdue as any[]).length, overdueTotalZar: overdueTotal, escalations: (esc as any[]).length,
      });
      await sendProactiveWhatsApp(to, { fallbackBody: brief });
      console.log(`[scheduler] evening brief sent → ${clinic.name}`);
    } catch (e: any) {
      console.error('[scheduler] evening brief failed', clinic.id, e?.message ?? e);
    }
  }
}

/** Daily: re-check clinics whose white-label sending domain is awaiting DNS, and
 *  flip them to verified once Resend confirms — so they auto-upgrade to sending
 *  from their own domain with no manual step. */
async function verifyPendingEmailDomains() {
  if (!config.email.enabled) return;
  const pending = await getClinicsWithPendingEmailDomain();
  for (const c of pending as any[]) {
    try {
      await verifyDomain(c.email_domain_id);
      const d = await getDomain(c.email_domain_id);
      if (d.status === 'verified') {
        await updateClinicEmailDomainStatus(c.id, 'verified', d.records);
        console.log(`[email-domains] ${c.email_domain} verified → ${c.name} now sends white-label`);
      }
    } catch (e: any) {
      console.error(`[email-domains] verify ${c.email_domain} failed:`, e?.message ?? e);
    }
  }
}

async function maybeRunDailyJobs() {
  const { dateStr, hour } = clinicNow();
  if (dateStr === _lastDailyDate || hour < DAILY_HOUR) return;
  _lastDailyDate = dateStr;
  console.log('[scheduler] running daily jobs for', dateStr);
  // POPIA data-retention purge — runs regardless of a default clinic.
  const retentionDays = parseInt(process.env.RETENTION_DAYS ?? '730', 10);
  await purgeExpiredData(retentionDays).catch((e) => console.error('[retention]', e));
  // Auto-verify pending white-label email domains (flips to live once DNS lands).
  await verifyPendingEmailDomains().catch((e) => console.error('[email-domains]', e));
  if (config.defaultClinicId) {
    await ownerSummary(config.defaultClinicId).catch((e) => console.error('[ownerSummary]', e));
    await reactivation(config.defaultClinicId).catch((e) => console.error('[reactivation]', e));
    // Monthly report — once per calendar month, on/after MONTHLY_REPORT_DAY.
    const monthKey = dateStr.slice(0, 7);
    const day = parseInt(dateStr.slice(8, 10), 10);
    const reportDay = parseInt(process.env.MONTHLY_REPORT_DAY ?? '1', 10);
    if (monthKey !== _lastMonthlyKey && day >= reportDay) {
      _lastMonthlyKey = monthKey;
      await monthlyReport(config.defaultClinicId).catch((e) => console.error('[monthlyReport]', e));
    }
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
    maybeRunHuddle().catch((e) => console.error('[scheduler] huddle error:', e));
    maybeRunEveningBrief().catch((e) => console.error('[scheduler] evening brief error:', e));
    maybeRunDailyJobs().catch((e) => console.error('[scheduler] daily jobs error:', e));
    maybeRunInvoiceChase().catch((e) => console.error('[scheduler] invoice chase error:', e));
  }, 60_000);
}

// Run standalone when invoked directly (e.g. a dedicated Render worker).
if (require.main === module) startScheduler();
