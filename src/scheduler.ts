/**
 * Reminder scheduler — run with: npm run scheduler
 * Polls every 60 seconds for due reminders and sends WhatsApp messages.
 */
import { config } from './config'; // also loads dotenv
import { installFetchTimeout } from './lib/httpTimeout';
import { initMonitoring } from './lib/monitoring';
import { getDueReminders, markReminderSent, markReminderFailed, claimReminder, getClinic, getLapsedClients, markReactivated, purgeExpiredData, getReportData, getStaleOpenConversations, markFollowupSent, getTodaysBookings, getBookingsForDate, getClinicsWithSummaryPhone, getClinicIdsWithOverdueInvoices, getClientsWithBirthdayToday, getClientsWithAnniversaryToday, getClientsWithLowPackage, getMembershipsToSync, setMembershipStatus, getActiveClinics, getPendingMembershipsToReconcile, activateMembership, claimSchedulerRun, purgeOldSchedulerRuns, isSuppressed, getGrowthSettings } from './db';
import { runGrowthGenerators } from './lib/growthEngine';
import { syncMembershipStatus, reconcilePendingMembership } from './lib/subscriptions';
import { phoneKey } from './lib/chase';
import { sendProactiveWhatsApp, sendMarketingWhatsApp } from './lib/twilio';
import { getClinicsWithEmailInbox, getOrCreateClientByEmail, getOrCreateConversation, saveMessage, getHistory, markProcessedOnce } from './db';
import { processInbox, sendEmailReply, replySubject } from './lib/emailInbox';
import { triageEmail } from './lib/emailTriage';
import { runAgent } from './brain/agent';
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

// Inbound email is polled on a slower cadence than the 60s reminder tick —
// opening IMAP per clinic every minute is wasteful and most clinics are low-volume.
const EMAIL_POLL_MS = parseInt(process.env.EMAIL_POLL_MINUTES ?? '3', 10) * 60_000;
let _lastEmailPoll = 0;

/**
 * Read each connected clinic's mailbox, triage every unseen email, and let the
 * booking brain reply (threaded, from the clinic's own address) to genuine
 * client enquiries. Non-booking mail is left untouched (only marked read).
 */
async function processClinicEmails(nowMs: number) {
  if (nowMs - _lastEmailPoll < EMAIL_POLL_MS) return;
  _lastEmailPoll = nowMs;

  const clinics = await getClinicsWithEmailInbox();
  for (const clinic of clinics as any[]) {
    const cfg = clinic.email_inbox;
    try {
      const stats = await processInbox(cfg, async (email) => {
        // Dedupe on Message-ID so a re-read (or overlapping run) can't double-reply.
        if (email.messageId && !(await markProcessedOnce(`email:${email.messageId}`))) return 'skipped';

        const triage = await triageEmail(email, cfg.user, clinic.name);
        if (!triage.handle) {
          console.log(`[email] skip ${clinic.name} <- ${email.fromAddress}: ${triage.reason}`);
          return 'skipped';
        }

        const { client: customer, isNew } = await getOrCreateClientByEmail(clinic.id, email.fromAddress, email.fromName);
        const convo = await getOrCreateConversation(clinic.id, customer.id);
        await saveMessage(convo.id, 'in', `[email] ${email.subject}\n\n${email.text}`);

        const history = await getHistory(convo.id);
        const reply = await runAgent(clinic, customer, convo, history, isNew);

        await sendEmailReply(cfg, {
          to: email.fromAddress,
          subject: replySubject(email.subject),
          text: reply,
          inReplyTo: email.messageId || undefined,
          references: email.references,
        });
        await saveMessage(convo.id, 'out', reply);
        console.log(`[email] replied ${clinic.name} -> ${email.fromAddress}`);
        return 'replied';
      });
      if (stats.fetched) console.log(`[email] ${clinic.name}: ${JSON.stringify(stats)}`);
    } catch (e) {
      console.error(`[email] inbox poll failed for ${clinic.name}:`, (e as Error)?.message ?? e);
    }
  }
}

async function _tick() {
  await processFollowups().catch((e) => console.error('[followups]', e));
  await processClinicEmails(Date.now()).catch((e) => console.error('[email]', e));
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
        // Review requests are MARKETING — never send to an opted-out contact.
        if (await isSuppressed(booking.clinic_id, config.twilio.channel, phoneKey(client.phone))) {
          await markReminderSent(r.id); continue;
        }
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
    try {
      await sendProactiveWhatsApp(client.phone, { contentSid, variables, fallbackBody: msg });
      await markReminderSent(r.id);
      console.log(`[scheduler] sent ${r.kind} reminder → ${client.phone}`);
    } catch (e) {
      // A send failure must NOT strand the reminder in 'sending' forever, nor
      // abort the rest of this tick (other reminders still need to go out).
      // Mark it failed (terminal + visible) and carry on.
      await markReminderFailed(r.id);
      console.error(`[scheduler] reminder ${r.id} (${r.kind}) send FAILED → ${client.phone}:`, (e as Error)?.message ?? e);
    }
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
    await sendMarketingWhatsApp(clinicId, c.phone, {
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
  _lastChaseDate = dateStr; // per-process fast-path
  if (!(await claimSchedulerRun(`chase:${dateStr}`))) return; // once per weekday, durably

  // 1. Auto-sync invoices from connected accounting sources (Xero/QBO/Sage/Sheet).
  const sourceClinics = await getClinicsWithInvoiceSource().catch(() => []);
  for (const c of sourceClinics as any[]) {
    await syncInvoicesForClinic(c.id).catch((e) => console.error('[invoice-sync]', c.id, e?.message ?? e));
  }

  // 2. Chase overdue invoices across EVERY clinic with overdue invoices or a
  //    connected source — not just a single default clinic.
  const ids = [...new Set([...(await getClinicIdsWithOverdueInvoices()), ...sourceClinics.map((c: any) => c.id)])];
  let total = 0;
  for (const id of ids) total += await runChaseForClinic(id).catch((e) => (console.error('[chase]', e), 0));
  if (total) console.log(`[scheduler] invoice chase: ${total} message(s) sent across ${ids.length} clinic(s)`);
}

const HUDDLE_HOUR = parseInt(process.env.HUDDLE_HOUR ?? '7', 10);
const EVENING_HOUR = parseInt(process.env.EVENING_BRIEF_HOUR ?? '17', 10);
// Briefs are greetings tied to a time of day. If the scheduler only comes up well
// after the scheduled hour (e.g. a deploy/restart at 3pm), skip the brief rather
// than send a stale "good morning" in the afternoon. Window = [hour, hour+grace).
const BRIEF_GRACE_HOURS = parseInt(process.env.BRIEF_GRACE_HOURS ?? '3', 10);
const inBriefWindow = (hour: number, scheduledHour: number) =>
  hour >= scheduledHour && hour < scheduledHour + BRIEF_GRACE_HOURS;

// Per-clinic once-a-day guard, keyed `${clinicId}:${dateStr}:${kind}`. Cleared
// when the day rolls over so it never grows unbounded.
const _briefsSent = new Set<string>();
let _briefsDay = '';
/** True if this brief was already sent today. In-memory Set is a per-process
 *  fast-path; the DB claim is authoritative across restarts + instances. */
async function alreadySent(key: string, dateStr: string): Promise<boolean> {
  if (dateStr !== _briefsDay) { _briefsSent.clear(); _briefsDay = dateStr; }
  if (_briefsSent.has(key)) return true;
  _briefsSent.add(key);
  const claimed = await claimSchedulerRun(`brief:${key}`);
  return !claimed; // already claimed elsewhere → treat as already sent
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
  if (!inBriefWindow(hour, HUDDLE_HOUR)) return;
  for (const clinic of await briefRecipients()) {
    const to = clinic.owner_summary_phone || clinic.escalation_contact;
    if (!to || await alreadySent(`${clinic.id}:${dateStr}:morning`, dateStr)) continue;
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
  if (!inBriefWindow(hour, EVENING_HOUR)) return;
  for (const clinic of await briefRecipients()) {
    const to = clinic.owner_summary_phone || clinic.escalation_contact;
    if (!to || await alreadySent(`${clinic.id}:${dateStr}:evening`, dateStr)) continue;
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

/** Send birthday greetings to consented clients whose birthday is today. */
async function birthdayTouches(clinicId: string) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;
  const clients = await getClientsWithBirthdayToday(clinicId);
  for (const c of clients as any[]) {
    if (!c.phone) continue;
    try {
      await sendProactiveWhatsApp(c.phone, {
        fallbackBody: `Happy birthday${c.name ? `, ${c.name}` : ''}! 🎂 Treat yourself today — we'd love to see you soon. Book anytime right here.`,
      });
      console.log(`[scheduler] birthday touch → ${c.name ?? c.phone}`);
    } catch (e: any) {
      console.error('[scheduler] birthday touch error', e?.message ?? e);
    }
  }
}

/** Send anniversary greetings to consented clients whose anniversary is today. */
async function anniversaryTouches(clinicId: string) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;
  const clients = await getClientsWithAnniversaryToday(clinicId);
  for (const c of clients as any[]) {
    if (!c.phone) continue;
    try {
      await sendProactiveWhatsApp(c.phone, {
        fallbackBody: `Happy anniversary${c.name ? `, ${c.name}` : ''}! 🎉 Wishing you a wonderful day. Remember, we're always here when you need a little pampering.`,
      });
      console.log(`[scheduler] anniversary touch → ${c.name ?? c.phone}`);
    } catch (e: any) {
      console.error('[scheduler] anniversary touch error', e?.message ?? e);
    }
  }
}

/** Nudge clients with 2 or fewer sessions remaining on their prepaid package. */
async function lowPackageNudges(clinicId: string) {
  const threshold = parseInt(process.env.LOW_PACKAGE_THRESHOLD ?? '2', 10);
  const packages = await getClientsWithLowPackage(clinicId, threshold);
  for (const pkg of packages as any[]) {
    const client = pkg.clients;
    if (!client?.phone || !client.consent_at) continue;
    const remaining = pkg.sessions_total - pkg.sessions_used;
    try {
      await sendProactiveWhatsApp(client.phone, {
        fallbackBody: `Hi${client.name ? ` ${client.name}` : ''}! Just a heads up — you have ${remaining} session${remaining !== 1 ? 's' : ''} left on your "${pkg.name}" package. Book now to lock in your next appointment.`,
      });
      console.log(`[scheduler] low-package nudge → ${client.name ?? client.phone} (${remaining} left)`);
    } catch (e: any) {
      console.error('[scheduler] low-package nudge error', e?.message ?? e);
    }
  }
}

/** Reconcile membership status + renewal dates from the clinic's own provider
 *  (Stripe/PayFast/Paystack). We can't rely on clinics configuring webhooks, so
 *  we poll subscriptions daily and flip rows to past_due/cancelled as reported. */
async function syncMemberships(clinicId: string) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;
  const rows = await getMembershipsToSync(clinicId);
  for (const m of rows as any[]) {
    try {
      const synced = await syncMembershipStatus(clinic, m);
      if (!synced) continue;
      if (!synced.status) { // provider returned an unrecognised status — leave unchanged
        console.warn(`[scheduler] membership ${m.id} unknown provider status — left as ${m.status}`);
        continue;
      }
      const renews = synced.renewsAt ?? m.renews_at;
      if (synced.status !== m.status || (synced.renewsAt && synced.renewsAt !== m.renews_at)) {
        await setMembershipStatus(m.id, synced.status, renews);
        console.log(`[scheduler] membership ${m.id} → ${synced.status}`);
      }
    } catch (e: any) {
      console.error('[scheduler] membership sync error', m.id, e?.message ?? e);
    }
  }
}

/** Catch memberships the client paid for but never confirmed (closed the tab).
 *  Re-checks each recent pending membership against the provider via its stored
 *  checkout ref and activates it if the payment actually went through — so a
 *  paying member is never silently stuck on "pending". */
async function reconcilePendingMemberships(clinicId: string) {
  const clinic = await getClinic(clinicId);
  if (!clinic) return;
  const rows = await getPendingMembershipsToReconcile(clinicId);
  for (const m of rows as any[]) {
    try {
      const confirmed = await reconcilePendingMembership(clinic, m);
      if (confirmed) {
        await activateMembership(m.id, confirmed.externalId, confirmed.renewsAt);
        console.log(`[scheduler] reconciled stranded membership ${m.id} → active`);
        if (m.clients?.phone) {
          await sendProactiveWhatsApp(m.clients.phone, {
            fallbackBody: `You're all set! 🎉 Your ${m.plan_name} membership at ${clinic.name} is now active.`,
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      console.error('[scheduler] membership reconcile error', m.id, e?.message ?? e);
    }
  }
}

/** Run the growth generators for a clinic. Owner-guided: each opportunity becomes
 *  a pending proposal the owner approves (with the specifics) — Remi just pings
 *  them. Types set to "auto" execute within guardrails and skip the ping. */
async function growthCampaigns(clinic: any) {
  const settings = await getGrowthSettings(clinic.id);
  const created = await runGrowthGenerators(clinic, settings);
  const to = clinic.owner_summary_phone || clinic.escalation_contact;
  if (!to) return;
  for (const p of created) {
    await sendProactiveWhatsApp(to, {
      fallbackBody: `📈 Remi spotted a way to fill your diary: ${p.title}. Open your Remi dashboard → Growth to review and approve (set a discount if you'd like).`,
    }).catch(() => {});
  }
}

async function maybeRunDailyJobs() {
  const { dateStr, hour } = clinicNow();
  if (dateStr === _lastDailyDate || hour < DAILY_HOUR) return;
  _lastDailyDate = dateStr; // per-process fast-path
  // Authoritative cross-restart / cross-instance guard: only one run per day wins.
  if (!(await claimSchedulerRun(`daily:${dateStr}`))) return;
  console.log('[scheduler] running daily jobs for', dateStr);
  // POPIA data-retention purge — runs regardless of a default clinic.
  const retentionDays = parseInt(process.env.RETENTION_DAYS ?? '730', 10);
  await purgeExpiredData(retentionDays).catch((e) => console.error('[retention]', e));
  await purgeOldSchedulerRuns().catch((e) => console.error('[scheduler-runs purge]', e));
  // Auto-verify pending white-label email domains (flips to live once DNS lands).
  await verifyPendingEmailDomains().catch((e) => console.error('[email-domains]', e));
  // Per-tenant daily jobs run for EVERY onboarded clinic, not just a default one.
  // Each job self-guards (owner phone, consent, etc.); a failure in one clinic
  // never aborts the rest.
  const clinics = await getActiveClinics();
  const monthKey = dateStr.slice(0, 7);
  const day = parseInt(dateStr.slice(8, 10), 10);
  const reportDay = parseInt(process.env.MONTHLY_REPORT_DAY ?? '1', 10);
  // Once-per-month, durably (claim survives restarts within the month).
  const doMonthly = day >= reportDay && (await claimSchedulerRun(`monthly:${monthKey}`));

  for (const clinic of clinics as any[]) {
    const id = clinic.id;
    await ownerSummary(id).catch((e) => console.error('[ownerSummary]', id, e));
    await reactivation(id).catch((e) => console.error('[reactivation]', id, e));
    await birthdayTouches(id).catch((e) => console.error('[birthday]', id, e));
    await anniversaryTouches(id).catch((e) => console.error('[anniversary]', id, e));
    await lowPackageNudges(id).catch((e) => console.error('[low-package]', id, e));
    await syncMemberships(id).catch((e) => console.error('[membership-sync]', id, e));
    await reconcilePendingMemberships(id).catch((e) => console.error('[membership-reconcile]', id, e));
    await growthCampaigns(clinic).catch((e) => console.error('[growth]', id, e));
    if (doMonthly) await monthlyReport(id).catch((e) => console.error('[monthlyReport]', id, e));
  }
  console.log(`[scheduler] daily jobs ran for ${clinics.length} clinic(s)`);
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
  // A hung external call must never freeze the serial tick (which would silently
  // halt all reminders). Bound every outbound fetch.
  installFetchTimeout();
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

// Run standalone when invoked directly (e.g. a dedicated Render worker). Register
// crash handlers + alerting too — otherwise a worker crash is invisible.
if (require.main === module) {
  void initMonitoring();
  startScheduler();
}
