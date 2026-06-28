import { supabase } from './lib/supabase';
import { buildReminderRows } from './lib/reminders';
import { isPackageActive, isLowPackage } from './lib/clientOs';
import { mergeGrowthSettings, cadenceOverdue, type GrowthSettings, type GrowthType } from './lib/growth';
import { generateReferralCode, extractReferralCode } from './lib/referral';
import { encryptPaymentConfig, decryptClinicSecrets, encryptField, encryptTokens } from './lib/secretCrypto';

export async function getClinic(id: string) {
  const { data } = await supabase.from('clinics').select('*').eq('id', id).single();
  return decryptClinicSecrets(data);
}

/** Look up a clinic by its Twilio number (voice or WhatsApp).
 *  For WhatsApp, checks the per-clinic whatsapp_number first (their own number
 *  connected through our Twilio account), then falls back to the shared twilio_number. */
export async function getClinicByNumber(to: string) {
  const number = to.replace(/^whatsapp:/, ''); // strip prefix if present
  // 1. Try per-clinic WhatsApp number (each clinic's own number)
  const { data: byWa } = await supabase.from('clinics').select('*').eq('whatsapp_number', number).maybeSingle();
  if (byWa) return decryptClinicSecrets(byWa);
  // 2. Fall back to shared Twilio number
  const { data } = await supabase.from('clinics').select('*').eq('twilio_number', number).maybeSingle();
  return decryptClinicSecrets(data ?? null);
}

/** Mark a clinic's onboarding as complete. */
export async function completeOnboarding(clinicId: string) {
  await supabase.from('clinics').update({ onboarding_completed_at: new Date().toISOString() }).eq('id', clinicId);
}

/** Save the clinic's WhatsApp number as pending connection by operator. */
export async function submitWhatsAppNumber(clinicId: string, number: string) {
  await supabase.from('clinics').update({ whatsapp_number: number, whatsapp_pending: true }).eq('id', clinicId);
}

export async function getOrCreateClient(clinicId: string, phone: string) {
  const { data: existing } = await supabase
    .from('clients')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing) return { client: existing, isNew: false };

  const { data } = await supabase
    .from('clients')
    .insert({ clinic_id: clinicId, phone, consent_at: new Date().toISOString() })
    .select()
    .single();
  return { client: data, isNew: true };
}

/** Like getOrCreateClient but keyed on email — for the inbound-email channel. */
export async function getOrCreateClientByEmail(clinicId: string, email: string, name?: string) {
  const addr = (email || '').toLowerCase().trim();
  const { data: existing } = await supabase
    .from('clients')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('email', addr)
    .maybeSingle();
  if (existing) return { client: existing, isNew: false };

  const { data } = await supabase
    .from('clients')
    .insert({ clinic_id: clinicId, email: addr, name: name || null, consent_at: new Date().toISOString() })
    .select()
    .single();
  return { client: data, isNew: true };
}

/** Clinics that have an enabled email inbox configured (Remi reads/replies to it). */
export async function getClinicsWithEmailInbox() {
  const { data } = await supabase.from('clinics').select('*').not('email_inbox', 'is', null);
  return (data ?? [])
    .filter((c: any) => c.email_inbox?.imap_host && c.email_inbox?.enabled !== false)
    .map(decryptClinicSecrets);
}

/** Save a clinic's email-inbox connection config (IMAP/SMTP + app-password). */
export async function setEmailInbox(clinicId: string, cfg: any) {
  const enc = cfg && cfg.pass != null ? { ...cfg, pass: encryptField(cfg.pass) } : cfg;
  await supabase.from('clinics').update({ email_inbox: enc }).eq('id', clinicId);
}

export async function getOrCreateConversation(clinicId: string, clientId: string) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing;

  const { data } = await supabase
    .from('conversations')
    .insert({
      clinic_id: clinicId,
      client_id: clientId,
      channel: 'whatsapp',
      status: 'open',
      last_message_at: new Date().toISOString(),
    })
    .select()
    .single();
  return data;
}

export async function saveMessage(conversationId: string, direction: 'in' | 'out', body: string) {
  await supabase.from('messages').insert({ conversation_id: conversationId, direction, body });
  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
}

/** Recent history mapped to Anthropic message format (in→user, out→assistant). */
export async function getHistory(conversationId: string, limit = 20) {
  // Fetch the MOST RECENT `limit` messages (descending), then restore
  // chronological order. Ordering ascending + limit returns the OLDEST messages,
  // which — once a conversation passes `limit` turns — drops the current user
  // message and leaves the history ending on an assistant turn. Gemini then has
  // nothing to reply to and returns empty ("Sorry, could you rephrase that?"),
  // permanently breaking every long conversation.
  const { data } = await supabase
    .from('messages')
    .select('direction,body')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).reverse().map((m: any) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.body,
  }));
}

export async function createBookingRow(o: {
  clinicId: string;
  clientId: string;
  service: string;
  startAt: string;
  endAt: string;
  calendarEventId: string;
  source: string;
}) {
  const { data } = await supabase
    .from('bookings')
    .insert({
      clinic_id: o.clinicId,
      client_id: o.clientId,
      service: o.service,
      start_at: o.startAt,
      end_at: o.endAt,
      status: 'confirmed',
      source: o.source,
      calendar_event_id: o.calendarEventId,
    })
    .select()
    .single();
  return data;
}

/** Find a still-confirmed booking matching the exact clinic+client+service+time
 *  (used for create-booking idempotency). */
export async function findConfirmedBooking(
  clinicId: string,
  clientId: string,
  service: string,
  startAtISO: string,
) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .eq('service', service)
    .eq('start_at', startAtISO)
    .eq('status', 'confirmed')
    .maybeSingle();
  return data;
}

export async function logEvent(
  clinicId: string,
  type: string,
  valueZar: number,
  bookingId?: string,
) {
  await supabase
    .from('events')
    .insert({ clinic_id: clinicId, type, value_zar: valueZar || 0, booking_id: bookingId ?? null });
}

export async function createEscalation(conversationId: string, reason: string, summary?: string) {
  await supabase
    .from('escalations')
    .insert({ conversation_id: conversationId, reason, summary, status: 'open' });
  await supabase.from('conversations').update({ status: 'escalated' }).eq('id', conversationId);
}

/**
 * Idempotency guard for webhook retries. Returns true if `sid` is being seen for
 * the FIRST time (caller should process it), false if it was already recorded
 * (a Twilio retry — caller should skip to avoid double bookings / replies).
 * Fails OPEN (returns true) if the dedup store is unavailable, so a transient DB
 * issue never silently drops a real message.
 */
export async function markProcessedOnce(sid: string): Promise<boolean> {
  if (!sid) return true;
  try {
    const { data, error } = await supabase
      .from('processed_messages')
      .upsert({ sid }, { onConflict: 'sid', ignoreDuplicates: true })
      .select('sid');
    if (error) {
      console.error('[idempotency] store error, failing open', error.message);
      return true;
    }
    // ignoreDuplicates → inserted rows come back; empty means it already existed.
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error('[idempotency] store threw, failing open', e);
    return true;
  }
}

/**
 * Release a previously-recorded SID so a Twilio retry can re-run it. Call this
 * if processing FAILED after markProcessedOnce returned true — otherwise the
 * retry would be deduped away and the customer's message lost.
 */
export async function unmarkProcessed(sid: string): Promise<void> {
  if (!sid) return;
  try {
    await supabase.from('processed_messages').delete().eq('sid', sid);
  } catch (e) {
    console.error('[idempotency] unmark failed', e);
  }
}

/**
 * POPIA data-retention purge: delete conversational personal information older
 * than the retention window (default 24 months, per the Privacy Policy). Keeps
 * booking/event rows (minimal business + "R recovered" audit records). Each
 * delete is independent so one failing doesn't block the others.
 */
export async function purgeExpiredData(retentionDays = 730): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const dedupCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const tasks: [string, PromiseLike<any>][] = [
    ['messages', supabase.from('messages').delete().lt('created_at', cutoff)],
    ['conversations', supabase.from('conversations').delete().lt('last_message_at', cutoff)],
    ['processed_messages', supabase.from('processed_messages').delete().lt('created_at', dedupCutoff)],
  ];
  for (const [name, p] of tasks) {
    try {
      const { error } = await p;
      if (error) console.error(`[retention] purge ${name} failed:`, error.message);
    } catch (e) {
      console.error(`[retention] purge ${name} threw:`, e);
    }
  }
  console.log(`[retention] purge complete (cutoff ${cutoff.slice(0, 10)})`);
}

// ---- Slice 2: reminders, cancellation/reschedule, waitlist, report ----

/** Schedule 48h/24h/2h reminders for a booking (only future ones). */
export async function scheduleReminders(bookingId: string, startAtISO: string) {
  const rows = buildReminderRows(bookingId, startAtISO);
  if (rows.length) await supabase.from('reminders').insert(rows);
}

/** Pending reminders that are due, with their booking + client embedded. */
export async function getDueReminders() {
  const { data } = await supabase
    .from('reminders')
    .select('id,kind,booking_id,bookings(clinic_id,service,start_at,status,clients(phone,name),clinics(name,google_review_url))')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(200); // bound a backlog so one tick can't run unbounded
  return data ?? [];
}

/**
 * Atomically claim a reminder for sending: flip pending→sending and report
 * whether THIS caller won the claim. Prevents the send-before-mark double-send
 * (on crash-recovery or a second scheduler instance). Returns false if another
 * worker already claimed it.
 */
export async function claimReminder(id: string): Promise<boolean> {
  const { data } = await supabase
    .from('reminders')
    .update({ status: 'sending' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  return Array.isArray(data) && data.length > 0;
}

export async function markReminderSent(id: string) {
  await supabase.from('reminders').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id);
}

/** Mark a reminder as failed so a send error doesn't strand it in 'sending'
 *  (claimed-but-never-completed) forever. Terminal + visible in the DB. */
export async function markReminderFailed(id: string) {
  await supabase.from('reminders').update({ status: 'failed' }).eq('id', id);
}

/** The client's next upcoming confirmed booking (used by cancel/reschedule). */
export async function getNextBooking(clinicId: string, clientId: string) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .eq('status', 'confirmed')
    .gt('start_at', new Date().toISOString())
    .order('start_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function setBookingStatus(id: string, status: string) {
  await supabase.from('bookings').update({ status }).eq('id', id);
}

/** Save a client's name (e.g. captured during booking) so it shows on the dashboard. */
export async function setClientName(clientId: string, name: string) {
  await supabase.from('clients').update({ name }).eq('id', clientId);
}

export async function setBookingDepositStatus(id: string, depositStatus: string) {
  await supabase.from('bookings').update({ deposit_status: depositStatus }).eq('id', id);
}

/** Remi's own subscription billing — which clinics are paid-up (via your Stripe). */
export async function setClinicSubscriptionStatus(clinicId: string, status: string) {
  await supabase.from('clinics').update({ subscription_status: status }).eq('id', clinicId);
}

export async function rescheduleBooking(id: string, newStartISO: string, newEndISO: string) {
  await supabase.from('bookings').update({ start_at: newStartISO, end_at: newEndISO }).eq('id', id);
  // Drop the booking's not-yet-sent reminders so a reschedule doesn't leave the
  // old 48h/24h/2h/aftercare/review rows firing at the original (now-wrong) times.
  await supabase.from('reminders').delete().eq('booking_id', id).eq('status', 'pending');
}

export async function addWaitlist(
  clinicId: string,
  clientId: string,
  service: string,
  preferredWindow?: string,
) {
  const { data } = await supabase
    .from('waitlist')
    .insert({ clinic_id: clinicId, client_id: clientId, service, preferred_window: preferredWindow, status: 'waiting' })
    .select()
    .single();
  return data;
}

/** Oldest waiting waitlist entry for a service, with client phone. */
export async function getNextWaitlist(clinicId: string, service: string) {
  const { data } = await supabase
    .from('waitlist')
    .select('*, clients(phone,name)')
    .eq('clinic_id', clinicId)
    .eq('status', 'waiting')
    .ilike('service', service ? `%${service}%` : '%')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function setWaitlistStatus(id: string, status: string) {
  await supabase.from('waitlist').update({ status }).eq('id', id);
}

// ── Dashboard waitlist management (receptionist add / reorder / remove) ───────
// `position` (migrate_waitlist_order.sql) drives manual ordering. Reads/adds fall
// back gracefully when the column isn't present yet so the panel still works.

/** Active (waiting/offered) entries with client info, in manual-priority order. */
export async function listWaitlist(clinicId: string) {
  const sel = 'id,service,preferred_window,status,created_at,clients(name,phone)';
  let res: any = await supabase
    .from('waitlist').select(`${sel},position`)
    .eq('clinic_id', clinicId).in('status', ['waiting', 'offered'])
    .order('position', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (res.error) { // position column not migrated yet — order by age
    res = await supabase
      .from('waitlist').select(sel)
      .eq('clinic_id', clinicId).in('status', ['waiting', 'offered'])
      .order('created_at', { ascending: true });
  }
  return res.data ?? [];
}

/** Add a receptionist-created entry at the back of the queue. */
export async function addWaitlistAtEnd(clinicId: string, clientId: string, service: string, preferredWindow?: string) {
  const base = { clinic_id: clinicId, client_id: clientId, service, preferred_window: preferredWindow ?? null, status: 'waiting' };
  const { data: last } = await supabase
    .from('waitlist').select('position').eq('clinic_id', clinicId)
    .order('position', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  const position = (Number(last?.position) || 0) + 1;
  let res = await supabase.from('waitlist').insert({ ...base, position }).select('id').single();
  if (res.error) res = await supabase.from('waitlist').insert(base).select('id').single(); // no position column
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

/** Persist a new ordering (position = rank). Needs the position column. */
export async function setWaitlistOrder(clinicId: string, orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await supabase.from('waitlist').update({ position: i + 1 }).eq('id', orderedIds[i]).eq('clinic_id', clinicId);
    if (error) throw new Error('Reordering needs the waitlist position column — run db/migrate_waitlist_order.sql.');
  }
}

/** Remove a waitlist entry. */
export async function removeWaitlistEntry(clinicId: string, id: string) {
  const { error } = await supabase.from('waitlist').delete().eq('id', id).eq('clinic_id', clinicId);
  if (error) throw new Error(error.message);
}

/** Single entry (with client id + contact) for converting to a booking. */
export async function getWaitlistEntry(clinicId: string, id: string) {
  const { data } = await supabase
    .from('waitlist').select('id,service,client_id,clients(name,phone)')
    .eq('clinic_id', clinicId).eq('id', id).maybeSingle();
  return data;
}

/** A waiting/offered waitlist row for this client (used to mark a backfill on booking). */
export async function getClientWaitlist(clinicId: string, clientId: string, service?: string) {
  const { data } = await supabase
    .from('waitlist')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .in('status', ['waiting', 'offered']);
  const rows = data ?? [];
  if (service) {
    const match = rows.find(
      (w: any) => String(w.service).toLowerCase() === String(service).toLowerCase(),
    );
    if (match) return match;
  }
  return rows[0] ?? null;
}

/** Recent conversations with the last message body, for the dashboard. */
export async function getRecentConversations(clinicId: string, limit = 15) {
  const { data } = await supabase
    .from('conversations')
    .select('id,status,channel,last_message_at,clients(phone,name)')
    .eq('clinic_id', clinicId)
    .order('last_message_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Open escalations waiting for a human. */
/** Today's confirmed bookings (clinic-local day) for the morning team huddle. */
/** Confirmed bookings on a specific clinic-local calendar day (YYYY-MM-DD). */
export async function getBookingsForDate(clinicId: string, dateStr: string, timeZone = 'Africa/Johannesburg') {
  // Anchor the UTC-offset lookup to the target date (handles DST in tz's that have it).
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${dateStr}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value;
  const off = part?.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '+00:00';
  const start = new Date(`${dateStr}T00:00:00${off}`).toISOString();
  const end = new Date(`${dateStr}T23:59:59${off}`).toISOString();
  const { data } = await supabase
    .from('bookings')
    .select('start_at,service,status,clients(name,intake_submitted_at)')
    .eq('clinic_id', clinicId)
    .eq('status', 'confirmed')
    .gte('start_at', start)
    .lte('start_at', end)
    .order('start_at', { ascending: true });
  return data ?? [];
}

export async function getTodaysBookings(clinicId: string, timeZone = 'Africa/Johannesburg') {
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD clinic-local
  return getBookingsForDate(clinicId, dateStr, timeZone);
}

/** Atomically claim a once-per-period scheduler job. Returns true if THIS call
 *  claimed it (run the job), false if already claimed by a prior run or another
 *  instance. Survives restarts and coordinates across multiple instances, so a
 *  redeploy or a second worker can't re-send owner briefs / chases. */
export async function claimSchedulerRun(key: string): Promise<boolean> {
  const { data } = await supabase
    .from('scheduler_runs')
    .upsert({ key }, { onConflict: 'key', ignoreDuplicates: true })
    .select('key');
  return (data?.length ?? 0) > 0;
}

/** Trim old scheduler-run markers so the table doesn't grow unbounded. */
export async function purgeOldSchedulerRuns(days = 45) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  await supabase.from('scheduler_runs').delete().lt('ran_at', cutoff);
}

/** Clinics that have opted into proactive briefs by configuring a summary phone. */
export async function getClinicsWithSummaryPhone() {
  const { data } = await supabase
    .from('clinics')
    .select('id,name,timezone,owner_summary_phone,escalation_contact')
    .not('owner_summary_phone', 'is', null);
  return data ?? [];
}

/** All onboarded clinics — the per-tenant set the scheduler's daily jobs loop over.
 *  Filters to clinics that finished onboarding so we don't message half-set-up
 *  tenants. Each daily job still self-guards (owner phone, consent, etc.). */
export async function getActiveClinics() {
  const { data } = await supabase
    .from('clinics')
    .select('id,name,timezone')
    .not('onboarding_completed_at', 'is', null);
  return data ?? [];
}

/** Fetch a single client by id (for the intake form). */
export async function getClientById(clientId: string) {
  const { data } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
  return data;
}

/** Save a patient's submitted intake form against their client record. */
export async function saveIntake(clientId: string, intake: any) {
  await supabase
    .from('clients')
    .update({ intake_json: intake, intake_submitted_at: new Date().toISOString() })
    .eq('id', clientId);
}

/** Create a clinic (self-serve onboarding). Returns the new row incl. its
 *  generated per-clinic dashboard_token. */
export async function createClinic(obj: {
  name: string;
  timezone?: string;
  hours_json?: any;
  services_json?: any;
  faq_json?: any;
  owner_summary_phone?: string;
  escalation_contact?: string;
  knowledge?: string;
  dashboard_token: string;
  plan?: string;
  subscription_status?: string;
}) {
  // Only write the columns we were actually given. Forcing nulls for every
  // optional column makes the whole insert fail if the DB is behind on a
  // migration (e.g. a missing `knowledge` column) — so set just what's provided.
  const row: Record<string, any> = {
    name: obj.name,
    timezone: obj.timezone ?? 'Africa/Johannesburg',
    dashboard_token: obj.dashboard_token,
    booking_provider: 'google',
  };
  if (obj.hours_json !== undefined) row.hours_json = obj.hours_json;
  if (obj.services_json !== undefined) row.services_json = obj.services_json;
  if (obj.faq_json !== undefined) row.faq_json = obj.faq_json;
  if (obj.owner_summary_phone !== undefined) row.owner_summary_phone = obj.owner_summary_phone;
  if (obj.escalation_contact !== undefined) row.escalation_contact = obj.escalation_contact;
  if (obj.knowledge !== undefined) row.knowledge = obj.knowledge;
  if (obj.plan) row.plan = obj.plan;
  if (obj.subscription_status) row.subscription_status = obj.subscription_status;

  const { data, error } = await supabase.from('clinics').insert(row).select('id').single();
  if (error) throw new Error(error.message);
  return data;
}

/** Set a clinic's dashboard tier ('paidup' | 'basic' | 'standard' | 'complete'). */
export async function setClinicPlan(clinicId: string, plan: string) {
  const { error } = await supabase.from('clinics').update({ plan }).eq('id', clinicId);
  if (error) throw new Error(error.message);
}

// ── Platform admins (operator god-view across all clinics) ────────────────────

/** Is this auth user a Remi platform admin (sees all clinics)? */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

/** Grant platform-admin (used by scripts/addPlatformAdmin.ts). */
export async function addPlatformAdmin(userId: string) {
  const { error } = await supabase.from('platform_admins').upsert({ user_id: userId }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

/** Every clinic with rolled-up stats for the operator dashboard. */
export async function listClinicsForAdmin() {
  const { data: clinics } = await supabase
    .from('clinics')
    .select('id,name,plan,subscription_status,created_at')
    .order('created_at', { ascending: true });
  const out: any[] = [];
  for (const c of clinics ?? []) {
    const [bk, cv, esc, lastConv] = await Promise.all([
      supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('clinic_id', c.id).eq('status', 'confirmed'),
      supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('clinic_id', c.id),
      getOpenEscalations(c.id).catch(() => []),
      supabase.from('conversations').select('last_message_at').eq('clinic_id', c.id).order('last_message_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    out.push({
      id: c.id,
      name: c.name,
      plan: c.plan ?? 'complete',
      subscription_status: c.subscription_status ?? null,
      created_at: c.created_at,
      bookings: bk.count ?? 0,
      conversations: cv.count ?? 0,
      open_escalations: Array.isArray(esc) ? esc.length : 0,
      last_activity: (lastConv as any)?.data?.last_message_at ?? null,
    });
  }
  return out;
}

/** Set a conversation's status (e.g. 'booked' once an appointment is made). */
export async function setConversationStatus(id: string, status: string) {
  await supabase.from('conversations').update({ status }).eq('id', id);
}

/** Open conversations that enquired between min/max hours ago and haven't yet had
 *  a follow-up — candidates for a one-time "still keen?" nudge. Global across clinics. */
export async function getStaleOpenConversations(minHours: number, maxHours: number, limit = 100) {
  const now = Date.now();
  const newerThan = new Date(now - maxHours * 3_600_000).toISOString();
  const olderThan = new Date(now - minHours * 3_600_000).toISOString();
  const { data } = await supabase
    .from('conversations')
    .select('id,clinic_id,last_message_at,clients(phone,name),clinics(name)')
    .eq('status', 'open')
    .is('followup_sent_at', null)
    .gte('last_message_at', newerThan)
    .lte('last_message_at', olderThan)
    .limit(limit);
  return data ?? [];
}

/** Mark a conversation as having had its one-time follow-up sent. */
export async function markFollowupSent(id: string) {
  await supabase.from('conversations').update({ followup_sent_at: new Date().toISOString() }).eq('id', id);
}

/** Count conversations for a clinic since a date (for the dashboard conversion rate). */
export async function countConversations(clinicId: string, sinceISO: string): Promise<number> {
  const { count } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('clinic_id', clinicId)
    .gte('last_message_at', sinceISO);
  return count ?? 0;
}

export async function getOpenEscalations(clinicId: string) {
  // Escalations have no clinic_id of their own — scope via the linked conversation
  // (!inner makes it a filterable inner join). Without this, one clinic's
  // dashboard would show EVERY clinic's escalations (cross-tenant data leak).
  const { data } = await supabase
    .from('escalations')
    .select('id,reason,summary,created_at,conversations!inner(clinic_id,client_id,clients(phone,name))')
    .eq('status', 'open')
    .eq('conversations.clinic_id', clinicId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

/**
 * Consented clients whose most recent booking is older than `days` ago, who
 * haven't booked since, and who haven't been nudged within `days`. POPIA-safe:
 * only clients with consent_at set are returned.
 */
export async function getLapsedClients(clinicId: string, days: number, limit = 20) {
  const cutoff = Date.now() - days * 86400000;
  const { data: clients } = await supabase
    .from('clients')
    .select('id,name,phone,consent_at,last_reactivated_at')
    .eq('clinic_id', clinicId)
    .not('consent_at', 'is', null);
  if (!clients?.length) return [];

  const ids = clients.map((c) => c.id);
  const { data: bks } = await supabase
    .from('bookings')
    .select('client_id,start_at')
    .eq('clinic_id', clinicId)
    .in('client_id', ids);

  const latest: Record<string, number> = {};
  for (const b of bks ?? []) {
    const t = new Date(b.start_at).getTime();
    if (!latest[b.client_id] || t > latest[b.client_id]) latest[b.client_id] = t;
  }

  const out: any[] = [];
  for (const c of clients) {
    const last = latest[c.id];
    if (!last || last >= cutoff) continue; // never booked, or booked recently → not lapsed
    if (c.last_reactivated_at && new Date(c.last_reactivated_at).getTime() >= cutoff) continue; // already nudged recently
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

export async function markReactivated(clientId: string) {
  await supabase.from('clients').update({ last_reactivated_at: new Date().toISOString() }).eq('id', clientId);
}

export async function getReportData(clinicId: string, sinceISO: string) {
  const { data: events } = await supabase
    .from('events')
    .select('type,value_zar,created_at')
    .eq('clinic_id', clinicId)
    .gte('created_at', sinceISO);
  const { data: bookings } = await supabase
    .from('bookings')
    .select('status,created_at')
    .eq('clinic_id', clinicId)
    .gte('created_at', sinceISO);
  return { events: events ?? [], bookings: bookings ?? [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// INVOICE CHASING (PaidUp engine, ported). Tables: invoices, invoice_chases,
// suppressions. Kill switch + cadence live on the clinics row.
// ─────────────────────────────────────────────────────────────────────────────

/** Upsert an invoice by (clinic_id, invoice_number) so CSV re-imports are idempotent.
 *  Only overwrites contact/amount/date on conflict — never resets chase progress. */
export async function upsertInvoice(clinicId: string, inv: {
  invoice_number: string; contact_name?: string; contact_phone?: string; contact_email?: string;
  amount_due: number; currency?: string; due_date: string; source?: string; external_id?: string;
}) {
  const { data, error } = await supabase
    .from('invoices')
    .upsert({
      clinic_id: clinicId,
      invoice_number: inv.invoice_number,
      external_id: inv.external_id ?? null,
      contact_name: inv.contact_name ?? null,
      contact_phone: inv.contact_phone ?? null,
      contact_email: inv.contact_email ?? null,
      amount_due: inv.amount_due,
      currency: inv.currency ?? 'ZAR',
      due_date: inv.due_date,
      source: inv.source ?? 'csv',
      status: 'overdue',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'clinic_id,invoice_number', ignoreDuplicates: false })
    .select()
    .single();
  if (error) throw new Error(`upsertInvoice: ${error.message}`);
  return data;
}

/** Overdue, undisputed, unpaid invoices for a clinic (due today or earlier). */
export async function getChaseableInvoices(clinicId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('invoices')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('status', 'overdue')
    .eq('disputed', false)
    .lte('due_date', today)
    .order('due_date', { ascending: true });
  return data ?? [];
}

export async function listInvoices(clinicId: string, limit = 200) {
  const { data } = await supabase
    .from('invoices')
    .select('*')
    .eq('clinic_id', clinicId)
    .order('due_date', { ascending: true })
    .limit(limit);
  return data ?? [];
}

export async function advanceInvoiceChase(invoiceId: string, stage: number) {
  await supabase
    .from('invoices')
    .update({ chase_stage: stage, last_chased_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', invoiceId);
}

export async function logInvoiceChase(o: {
  invoiceId: string; clinicId: string; stage: number; channel: string; recipient: string; body: string;
}) {
  await supabase.from('invoice_chases').insert({
    invoice_id: o.invoiceId, clinic_id: o.clinicId, stage: o.stage,
    channel: o.channel, recipient: o.recipient, body: o.body,
  });
}

/** Mark an invoice paid / snoozed / disputed (operator or reply-driven). */
export async function markInvoicePaid(invoiceId: string) {
  await supabase.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', invoiceId);
}
export async function snoozeInvoice(invoiceId: string, untilISODate: string) {
  await supabase.from('invoices').update({ snoozed_until: untilISODate, updated_at: new Date().toISOString() }).eq('id', invoiceId);
}
export async function disputeInvoice(invoiceId: string) {
  await supabase.from('invoices').update({ disputed: true, updated_at: new Date().toISOString() }).eq('id', invoiceId);
}

// ── Suppression list (opt-outs) ──────────────────────────────────────────────
export async function isSuppressed(clinicId: string, channel: string, identifier: string | null) {
  if (!identifier) return false;
  const { data } = await supabase
    .from('suppressions')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('channel', channel)
    .eq('identifier', identifier)
    .maybeSingle();
  return !!data;
}
export async function addSuppression(clinicId: string, channel: string, identifier: string | null, reason = 'stop') {
  if (!identifier) return;
  await supabase.from('suppressions').upsert(
    { clinic_id: clinicId, channel, identifier, reason },
    { onConflict: 'clinic_id,channel,identifier', ignoreDuplicates: true },
  );
}
/** Re-opt-in: remove a contact from the suppression list (e.g. they replied START). */
export async function removeSuppression(clinicId: string, channel: string, identifier: string | null) {
  if (!identifier) return;
  await supabase.from('suppressions').delete()
    .eq('clinic_id', clinicId).eq('channel', channel).eq('identifier', identifier);
}

/** Clinic ids that currently have at least one chaseable invoice (for the scheduler). */
export async function getClinicIdsWithOverdueInvoices(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('invoices')
    .select('clinic_id')
    .eq('status', 'overdue')
    .eq('disputed', false)
    .lte('due_date', today);
  return [...new Set((data ?? []).map((r: any) => r.clinic_id))];
}

// ── Invoice sources (auto-import from Xero/QuickBooks/Sage/Google Sheet) ──────

/** Clinics that have an invoice source connected (for the daily sync). */
export async function getClinicsWithInvoiceSource() {
  const { data } = await supabase
    .from('clinics')
    .select('id,name,invoice_source,invoice_source_tokens,invoice_source_config')
    .not('invoice_source', 'is', null);
  return (data ?? []).map(decryptClinicSecrets);
}

/** Persist refreshed OAuth tokens / config for a clinic's invoice source. */
export async function setInvoiceSourceData(clinicId: string, patch: { tokens?: any; config?: any }) {
  const update: any = {};
  if (patch.tokens !== undefined) update.invoice_source_tokens = encryptTokens(patch.tokens);
  if (patch.config !== undefined) update.invoice_source_config = patch.config;
  if (!Object.keys(update).length) return;
  const { error } = await supabase.from('clinics').update(update).eq('id', clinicId);
  if (error) throw new Error(`setInvoiceSourceData: ${error.message}`);
}

/** Connect a clinic to a source (called from the OAuth callback / sheet setup). */
export async function setInvoiceSource(clinicId: string, source: string, tokens: any, config: any) {
  const { error } = await supabase.from('clinics').update({
    invoice_source: source,
    invoice_source_tokens: encryptTokens(tokens),
    invoice_source_config: config,
  }).eq('id', clinicId);
  if (error) throw new Error(`setInvoiceSource: ${error.message}`);
}

/** After a sync, mark as paid any still-overdue invoice from this source that the
 *  provider no longer returns as overdue (i.e. it cleared upstream) — so we stop
 *  chasing invoices that have been paid. */
export async function reconcileSourceInvoices(clinicId: string, source: string, liveExternalIds: string[]) {
  const { data } = await supabase
    .from('invoices')
    .select('id,external_id')
    .eq('clinic_id', clinicId)
    .eq('source', source)
    .eq('status', 'overdue');
  const live = new Set(liveExternalIds);
  const cleared = (data ?? []).filter((r: any) => r.external_id && !live.has(r.external_id));
  for (const r of cleared as any[]) {
    await supabase.from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', r.id);
  }
  return cleared.length;
}

// ── White-label email sending domains (Resend Domains API) ───────────────────

/** Store a clinic's newly-provisioned sending domain (pending verification). */
export async function setClinicEmailDomain(clinicId: string, o: {
  domain: string; id: string; status: string; records: any; fromEmail: string; replyTo?: string;
}) {
  const { error } = await supabase.from('clinics').update({
    email_domain: o.domain,
    email_domain_id: o.id,
    email_domain_status: o.status,
    email_domain_records: o.records,
    chase_from_email: o.fromEmail,
    chase_reply_to: o.replyTo ?? o.fromEmail,
  }).eq('id', clinicId);
  if (error) throw new Error(`setClinicEmailDomain: ${error.message}`);
}

export async function updateClinicEmailDomainStatus(clinicId: string, status: string, records?: any) {
  const u: any = { email_domain_status: status };
  if (records) u.email_domain_records = records;
  const { error } = await supabase.from('clinics').update(u).eq('id', clinicId);
  if (error) throw new Error(`updateClinicEmailDomainStatus: ${error.message}`);
}

/** Clinics whose sending domain is still awaiting DNS verification. */
export async function getClinicsWithPendingEmailDomain() {
  const { data } = await supabase
    .from('clinics')
    .select('id,name,email_domain,email_domain_id,email_domain_status')
    .eq('email_domain_status', 'pending')
    .not('email_domain_id', 'is', null);
  return data ?? [];
}

/** Fetch one invoice by id (for the /pay route + payment webhooks). */
export async function getInvoiceById(id: string) {
  const { data } = await supabase.from('invoices').select('*').eq('id', id).maybeSingle();
  return data;
}

/** Mark an invoice paid by id (idempotent — only flips overdue→paid). */
export async function markInvoicePaidById(id: string) {
  // Mark paid from ANY non-paid state (sent/pending/overdue/draft) — a customer
  // can pay before an invoice goes overdue. `.neq('paid')` keeps it idempotent
  // (a replayed webhook re-running this is a no-op once status is already paid).
  await supabase.from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'paid');
}

/** Overdue invoices for a clinic that have already been chased (stage > 0) —
 *  used to match an inbound reply to the right invoices. */
export async function getOverdueChasedInvoices(clinicId: string) {
  const { data } = await supabase
    .from('invoices')
    .select('id,contact_phone,invoice_number,source')
    .eq('clinic_id', clinicId)
    .eq('status', 'overdue')
    .gt('chase_stage', 0);
  return data ?? [];
}

// ── Dashboard accounts (Supabase Auth user ↔ clinic ↔ role) ──────────────────

/** The clinic + role a logged-in dashboard user belongs to (one for now). */
export async function getUserClinic(userId: string): Promise<{ clinic_id: string; role: string } | null> {
  const { data } = await supabase
    .from('clinic_users')
    .select('clinic_id,role')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Link a user to a clinic with a role (done-for-you onboarding / admin). */
export async function linkUserToClinic(userId: string, clinicId: string, role = 'owner') {
  const { error } = await supabase
    .from('clinic_users')
    .upsert({ user_id: userId, clinic_id: clinicId, role }, { onConflict: 'user_id,clinic_id' });
  if (error) throw new Error(`linkUserToClinic: ${error.message}`);
}

// ── Dashboard Phase 2 read views ─────────────────────────────────────────────

export async function getInvoiceForClinic(clinicId: string, invoiceId: string) {
  const { data } = await supabase.from('invoices').select('*').eq('clinic_id', clinicId).eq('id', invoiceId).maybeSingle();
  return data;
}
export async function getInvoiceChases(invoiceId: string) {
  const { data } = await supabase.from('invoice_chases')
    .select('stage,channel,recipient,created_at').eq('invoice_id', invoiceId).order('created_at', { ascending: true });
  return data ?? [];
}
export async function listClinicBookings(clinicId: string, limit = 100) {
  const { data } = await supabase.from('bookings')
    .select('id,service,start_at,end_at,status,source,created_at,clients(name,phone)')
    .eq('clinic_id', clinicId).order('start_at', { ascending: false }).limit(limit);
  return data ?? [];
}
export async function listConversations(clinicId: string, limit = 100) {
  const { data } = await supabase.from('conversations')
    .select('id,channel,status,last_message_at,created_at,clients(name,phone)')
    .eq('clinic_id', clinicId).order('last_message_at', { ascending: false }).limit(limit);
  return data ?? [];
}
export async function getConversationForClinic(clinicId: string, conversationId: string) {
  const { data: convo } = await supabase.from('conversations')
    .select('id,channel,status,clients(name,phone)').eq('clinic_id', clinicId).eq('id', conversationId).maybeSingle();
  if (!convo) return null;
  const { data: messages } = await supabase.from('messages')
    .select('direction,body,created_at').eq('conversation_id', conversationId).order('created_at', { ascending: true });
  return { conversation: convo, messages: messages ?? [] };
}

// ── Remi copilot (manager assistant) actions ─────────────────────────────────

export async function getInvoiceByNumber(clinicId: string, invoiceNumber: string) {
  const { data } = await supabase.from('invoices').select('*')
    .eq('clinic_id', clinicId).eq('invoice_number', invoiceNumber).maybeSingle();
  return data;
}

export async function setChasingPaused(clinicId: string, paused: boolean) {
  const { error } = await supabase.from('clinics').update({ chasing_paused: paused }).eq('id', clinicId);
  if (error) throw new Error(`setChasingPaused: ${error.message}`);
}

/** Resolve an escalation, scoped to the clinic via its conversation. Returns false if not found/owned. */
export async function resolveEscalation(clinicId: string, escalationId: string): Promise<boolean> {
  const { data } = await supabase.from('escalations')
    .select('id,conversations!inner(clinic_id)')
    .eq('id', escalationId).eq('conversations.clinic_id', clinicId).maybeSingle();
  if (!data) return false;
  await supabase.from('escalations').update({ status: 'resolved' }).eq('id', escalationId);
  return true;
}

/** All clients for a clinic (the Customers view). */
export async function listClients(clinicId: string, limit = 200) {
  const { data } = await supabase.from('clients')
    .select('*').eq('clinic_id', clinicId).order('created_at', { ascending: false }).limit(limit);
  return data ?? [];
}

/** Update whitelisted clinic settings (Settings screen). Never touches secrets/tokens. */
export async function updateClinicSettings(clinicId: string, patch: Record<string, any>) {
  const ALLOWED = ['name', 'timezone', 'knowledge', 'owner_summary_phone', 'escalation_contact', 'default_prep', 'chase_cadence', 'chase_reply_to', 'services_json', 'hours_json', 'google_calendar_id'];
  const update: Record<string, any> = {};
  for (const k of ALLOWED) if (k in patch) update[k] = patch[k];
  if (!Object.keys(update).length) return;
  const { error } = await supabase.from('clinics').update(update).eq('id', clinicId);
  if (error) throw new Error(`updateClinicSettings: ${error.message}`);
}

/** Set a clinic's payment provider + its credentials (Settings → Connections). */
export async function setPaymentConfig(clinicId: string, provider: string, config: any) {
  const { error } = await supabase.from('clinics')
    .update({ payment_provider: provider, payment_config: encryptPaymentConfig(config) }).eq('id', clinicId);
  if (error) throw new Error(`setPaymentConfig: ${error.message}`);
}

// ── Team / users (dashboard members) ─────────────────────────────────────────

export async function listClinicUsers(clinicId: string) {
  const { data } = await supabase.from('clinic_users')
    .select('user_id,role,created_at').eq('clinic_id', clinicId).order('created_at', { ascending: true });
  return data ?? [];
}
export async function setClinicUserRole(clinicId: string, userId: string, role: string) {
  const { error } = await supabase.from('clinic_users').update({ role }).eq('clinic_id', clinicId).eq('user_id', userId);
  if (error) throw new Error(`setClinicUserRole: ${error.message}`);
}
export async function removeClinicUser(clinicId: string, userId: string) {
  const { error } = await supabase.from('clinic_users').delete().eq('clinic_id', clinicId).eq('user_id', userId);
  if (error) throw new Error(`removeClinicUser: ${error.message}`);
}
export async function countClinicOwners(clinicId: string): Promise<number> {
  const { data } = await supabase.from('clinic_users').select('user_id').eq('clinic_id', clinicId).eq('role', 'owner');
  return (data ?? []).length;
}

/** Cancel a booking (scoped to clinic). Returns false if not found. */
export async function cancelClinicBooking(clinicId: string, bookingId: string): Promise<boolean> {
  const { data } = await supabase.from('bookings').select('id').eq('clinic_id', clinicId).eq('id', bookingId).maybeSingle();
  if (!data) return false;
  await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId);
  return true;
}

// ---- Team Ops: staff, time entries, leave -----------------------------------

/** Match an inbound phone to a staff member of this clinic (→ staff mode). */
export async function getStaffByPhone(clinicId: string, phone: string) {
  const p = (phone || '').replace(/^whatsapp:/, '');
  const { data } = await supabase
    .from('staff').select('*')
    .eq('clinic_id', clinicId).eq('phone', p).eq('active', true).maybeSingle();
  return data ?? null;
}

export async function listStaff(clinicId: string) {
  const { data } = await supabase.from('staff').select('*').eq('clinic_id', clinicId).order('name');
  return data ?? [];
}

export async function addStaff(clinicId: string, s: { name: string; phone?: string; role?: string; pay_rate?: number }) {
  const { data } = await supabase.from('staff').insert({
    clinic_id: clinicId, name: s.name, phone: s.phone ? s.phone.replace(/^whatsapp:/, '') : null,
    role: s.role || 'practitioner', pay_rate: s.pay_rate ?? null,
  }).select().single();
  return data;
}

export async function removeStaff(clinicId: string, staffId: string) {
  await supabase.from('staff').delete().eq('clinic_id', clinicId).eq('id', staffId);
}

export async function getOpenTimeEntry(staffId: string) {
  const { data } = await supabase.from('time_entries').select('*').eq('staff_id', staffId).is('clock_out', null).maybeSingle();
  return data ?? null;
}

/** Clock in. Returns {ok:false,already:true} if already clocked in (the partial
 *  unique index also guards against races). */
export async function clockIn(staffId: string, clinicId: string, source = 'whatsapp') {
  if (await getOpenTimeEntry(staffId)) return { ok: false, already: true } as const;
  const { data, error } = await supabase.from('time_entries')
    .insert({ staff_id: staffId, clinic_id: clinicId, source }).select('clock_in').single();
  if (error) return { ok: false, already: true } as const;
  return { ok: true, clock_in: data!.clock_in } as const;
}

/** Clock out the open entry. Returns {ok:false} if not clocked in. */
export async function clockOut(staffId: string) {
  const open = await getOpenTimeEntry(staffId);
  if (!open) return { ok: false } as const;
  const out = new Date().toISOString();
  await supabase.from('time_entries').update({ clock_out: out }).eq('id', open.id);
  return { ok: true, clock_in: open.clock_in, clock_out: out } as const;
}

/** Time entries for a staff member since an ISO timestamp (for weekly hours). */
export async function getStaffTimeEntries(staffId: string, sinceISO: string) {
  const { data } = await supabase.from('time_entries').select('clock_in, clock_out')
    .eq('staff_id', staffId).gte('clock_in', sinceISO).order('clock_in');
  return data ?? [];
}

/** All staff currently clocked in at a clinic (for the dashboard live view). */
export async function getClockedIn(clinicId: string) {
  const { data } = await supabase.from('time_entries')
    .select('clock_in, staff(name, id)').eq('clinic_id', clinicId).is('clock_out', null);
  return data ?? [];
}

/** Timesheet rows: every entry at a clinic since ISO, with staff name. */
export async function getTimesheet(clinicId: string, sinceISO: string) {
  const { data } = await supabase.from('time_entries')
    .select('clock_in, clock_out, staff(id, name)')
    .eq('clinic_id', clinicId).gte('clock_in', sinceISO).order('clock_in', { ascending: false });
  return data ?? [];
}

export async function createLeaveRequest(
  staffId: string, clinicId: string,
  r: { start_date: string; end_date: string; type?: string; reason?: string },
) {
  const { data } = await supabase.from('leave_requests').insert({
    staff_id: staffId, clinic_id: clinicId, start_date: r.start_date, end_date: r.end_date,
    type: r.type || 'annual', reason: r.reason ?? null, status: 'pending',
  }).select().single();
  return data;
}

export async function listLeaveRequests(clinicId: string, status?: string) {
  let q = supabase.from('leave_requests').select('*, staff(name)').eq('clinic_id', clinicId);
  if (status) q = q.eq('status', status);
  const { data } = await q.order('created_at', { ascending: false });
  return data ?? [];
}

export async function decideLeave(clinicId: string, id: string, status: 'approved' | 'declined', decidedBy: string) {
  const { data } = await supabase.from('leave_requests')
    .update({ status, decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq('clinic_id', clinicId).eq('id', id).select('*, staff(name, phone)').single();
  return data;
}

// ---- Tasks & expenses (quick wins) ------------------------------------------

export async function addTask(
  clinicId: string,
  t: { title: string; note?: string; assignee?: string; due_at?: string; source?: string },
) {
  const { data } = await supabase.from('tasks').insert({
    clinic_id: clinicId, title: t.title, note: t.note ?? null, assignee: t.assignee ?? null,
    due_at: t.due_at ?? null, source: t.source ?? 'dashboard', status: 'open',
  }).select().single();
  return data;
}

export async function listTasks(clinicId: string, status?: 'open' | 'done') {
  let q = supabase.from('tasks').select('*').eq('clinic_id', clinicId);
  if (status) q = q.eq('status', status);
  const { data } = await q.order('created_at', { ascending: false }).limit(200);
  return data ?? [];
}

export async function countOpenTasks(clinicId: string): Promise<number> {
  const { count } = await supabase.from('tasks').select('*', { count: 'exact', head: true })
    .eq('clinic_id', clinicId).eq('status', 'open');
  return count ?? 0;
}

export async function completeTask(clinicId: string, id: string) {
  await supabase.from('tasks').update({ status: 'done', done_at: new Date().toISOString() })
    .eq('clinic_id', clinicId).eq('id', id);
}

export async function deleteTask(clinicId: string, id: string) {
  await supabase.from('tasks').delete().eq('clinic_id', clinicId).eq('id', id);
}

export async function addExpense(
  clinicId: string,
  e: { amount_zar: number; description?: string; category?: string; logged_by?: string },
) {
  const { data } = await supabase.from('expenses').insert({
    clinic_id: clinicId, amount_zar: e.amount_zar, description: e.description ?? null,
    category: e.category ?? null, logged_by: e.logged_by ?? null,
  }).select().single();
  return data;
}

export async function listExpenses(clinicId: string, sinceISO?: string) {
  let q = supabase.from('expenses').select('*').eq('clinic_id', clinicId);
  if (sinceISO) q = q.gte('created_at', sinceISO);
  const { data } = await q.order('created_at', { ascending: false }).limit(200);
  return data ?? [];
}

// ---- Client OS: profiles, packages, memberships -----------------------------

export async function getClientProfile(clientId: string) {
  const { data } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
  return data;
}

export async function updateClientProfile(
  clientId: string,
  fields: {
    notes?: string; preferences?: string; allergies?: string;
    tags?: string[]; birthday?: string; anniversary?: string;
    name?: string; email?: string;
  },
) {
  const { data } = await supabase.from('clients').update(fields).eq('id', clientId).select().single();
  return data;
}

// ── Packages ──────────────────────────────────────────────────────────────────

export async function listPackages(clinicId: string) {
  const { data } = await supabase
    .from('packages')
    .select('*, clients(name, phone)')
    .eq('clinic_id', clinicId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function getClientPackages(clinicId: string, clientId: string) {
  const { data } = await supabase
    .from('packages')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

/** Returns the first active (non-expired, sessions remaining) package for a client. */
export async function getActivePackage(clinicId: string, clientId: string) {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('packages')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('created_at', { ascending: true })
    .limit(20);
  return (data ?? []).find((p: any) => isPackageActive(p)) ?? null;
}

export async function decrementPackage(packageId: string) {
  // Atomic increment using RPC so two concurrent requests can't both see sessions_used < sessions_total.
  await supabase.rpc('increment_package_sessions_used', { pkg_id: packageId });
}

export async function upsertPackage(
  clinicId: string,
  clientId: string,
  pkg: { name: string; sessions_total: number; expires_at?: string },
) {
  const { data } = await supabase
    .from('packages')
    .insert({ clinic_id: clinicId, client_id: clientId, ...pkg })
    .select()
    .single();
  return data;
}

/** Clients whose active package has <= threshold sessions remaining. */
export async function getClientsWithLowPackage(clinicId: string, threshold = 2) {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('packages')
    .select('*, clients(name, phone, consent_at)')
    .eq('clinic_id', clinicId)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('sessions_used', { ascending: false });
  return (data ?? []).filter((p: any) => isLowPackage(p, threshold));
}

// ── Memberships ───────────────────────────────────────────────────────────────

export async function listMemberships(clinicId: string) {
  const { data } = await supabase
    .from('memberships')
    .select('*, clients(name, phone)')
    .eq('clinic_id', clinicId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function getClientMembership(clinicId: string, clientId: string) {
  const { data } = await supabase
    .from('memberships')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('client_id', clientId)
    .eq('status', 'active')
    .maybeSingle();
  return data;
}

export async function getMembershipById(id: string) {
  const { data } = await supabase
    .from('memberships')
    .select('*, clients(name, phone, email)')
    .eq('id', id)
    .maybeSingle();
  return data;
}

/** Create a not-yet-paid membership the client activates via a provider signup link. */
export async function createPendingMembership(
  clinicId: string,
  clientId: string,
  m: { plan_name: string; amount_zar: number; interval: 'month' | 'year'; provider: 'stripe' | 'payfast' | 'paystack' },
) {
  const { data } = await supabase
    .from('memberships')
    .insert({
      clinic_id: clinicId, client_id: clientId, status: 'pending',
      plan_name: m.plan_name, amount_zar: m.amount_zar, billing_interval: m.interval, provider: m.provider,
    })
    .select()
    .single();
  return data;
}

/** Mark a pending membership active once the provider confirms the subscription. */
export async function activateMembership(id: string, externalSubscriptionId: string, renewsAt: string | null) {
  // Only activate from pending/past_due — never re-open a cancelled membership via
  // a replayed/duplicate provider notification. maybeSingle() = no-op if it's
  // already active or was cancelled (returns null instead of throwing).
  const { data } = await supabase
    .from('memberships')
    .update({ status: 'active', external_subscription_id: externalSubscriptionId, renews_at: renewsAt })
    .eq('id', id)
    .in('status', ['pending', 'past_due'])
    .select()
    .maybeSingle();
  return data;
}

/** Active memberships that carry a provider subscription id — for the periodic sync. */
export async function getMembershipsToSync(clinicId: string) {
  const { data } = await supabase
    .from('memberships')
    .select('*')
    .eq('clinic_id', clinicId)
    .not('external_subscription_id', 'is', null)
    .in('status', ['active', 'past_due', 'paused']);
  return data ?? [];
}

/** Sync a membership's status + renewal date from the provider. */
export async function setMembershipStatus(id: string, status: string, renewsAt?: string | null) {
  const updates: Record<string, any> = { status };
  if (renewsAt !== undefined) updates.renews_at = renewsAt;
  const { data } = await supabase.from('memberships').update(updates).eq('id', id).select().single();
  return data;
}

/** Store the provider checkout reference (Stripe session / Paystack ref) at signup,
 *  so a paid-but-not-returned membership can be reconciled later. */
export async function setMembershipCheckoutRef(id: string, ref: string) {
  await supabase.from('memberships').update({ checkout_ref: ref }).eq('id', id);
}

/** Pending memberships with a checkout ref, created within the last `days` — these
 *  may have been paid but never confirmed (client closed the tab). Older ones are
 *  treated as abandoned and left alone. */
export async function getPendingMembershipsToReconcile(clinicId: string, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await supabase
    .from('memberships')
    .select('*, clients(name, phone, email)')
    .eq('clinic_id', clinicId)
    .eq('status', 'pending')
    .not('checkout_ref', 'is', null)
    .gte('created_at', since);
  return data ?? [];
}

// ── Birthday / anniversary helpers ────────────────────────────────────────────

/** Clients with birthday today (MM-DD match), consent_at set. */
export async function getClientsWithBirthdayToday(clinicId: string) {
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { data } = await supabase
    .from('clients')
    .select('id, name, phone, birthday')
    .eq('clinic_id', clinicId)
    .not('birthday', 'is', null)
    .not('consent_at', 'is', null)
    .not('phone', 'is', null);
  return (data ?? []).filter((c: any) => {
    const b: string = c.birthday ?? '';
    return b.slice(5) === mmdd; // 'YYYY-MM-DD' → 'MM-DD'
  });
}

/** Clients with anniversary today (MM-DD match), consent_at set. */
export async function getClientsWithAnniversaryToday(clinicId: string) {
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { data } = await supabase
    .from('clients')
    .select('id, name, phone, anniversary')
    .eq('clinic_id', clinicId)
    .not('anniversary', 'is', null)
    .not('consent_at', 'is', null)
    .not('phone', 'is', null);
  return (data ?? []).filter((c: any) => {
    const a: string = c.anniversary ?? '';
    return a.slice(5) === mmdd;
  });
}

// ---- Remi Growth: owner-guided campaign proposals --------------------------

/** A clinic's growth guardrails + per-type config, merged over safe defaults. */
export async function getGrowthSettings(clinicId: string): Promise<GrowthSettings> {
  const { data } = await supabase.from('clinics').select('growth_settings').eq('id', clinicId).maybeSingle();
  return mergeGrowthSettings(data?.growth_settings);
}

export async function setGrowthSettings(clinicId: string, settings: GrowthSettings) {
  await supabase.from('clinics').update({ growth_settings: settings }).eq('id', clinicId);
}

/** Create a pending (or, for auto types, pre-sent) growth proposal. */
export async function createGrowthProposal(clinicId: string, p: {
  type: GrowthType; title: string; detail?: string; payload?: any;
  status?: 'pending' | 'sent'; expires_at?: string;
}) {
  const { data } = await supabase.from('growth_proposals').insert({
    clinic_id: clinicId, type: p.type, title: p.title, detail: p.detail ?? null,
    payload: p.payload ?? {}, status: p.status ?? 'pending', expires_at: p.expires_at ?? null,
  }).select().single();
  return data;
}

/** List proposals for the dashboard Growth inbox (newest first). */
export async function listGrowthProposals(clinicId: string, status?: string) {
  let q = supabase.from('growth_proposals').select('*').eq('clinic_id', clinicId);
  if (status) q = q.eq('status', status);
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  return data ?? [];
}

export async function getGrowthProposal(clinicId: string, id: string) {
  const { data } = await supabase.from('growth_proposals').select('*')
    .eq('clinic_id', clinicId).eq('id', id).maybeSingle();
  return data;
}

export async function countPendingGrowthProposals(clinicId: string): Promise<number> {
  const { count } = await supabase.from('growth_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('clinic_id', clinicId).eq('status', 'pending');
  return count ?? 0;
}

/** Has a recent, still-open proposal of this type? Prevents the generators from
 *  re-proposing the same campaign every day while one awaits the owner. */
export async function hasOpenGrowthProposal(clinicId: string, type: GrowthType): Promise<boolean> {
  const { count } = await supabase.from('growth_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('clinic_id', clinicId).eq('type', type).in('status', ['pending', 'approved']);
  return (count ?? 0) > 0;
}

/** Owner approves/declines a proposal, optionally setting the specifics. */
export async function decideGrowthProposal(
  clinicId: string, id: string, status: 'approved' | 'declined', decidedBy: string, ownerInput?: any,
) {
  const { data } = await supabase.from('growth_proposals')
    .update({ status, decided_by: decidedBy, decided_at: new Date().toISOString(), ...(ownerInput ? { owner_input: ownerInput } : {}) })
    .eq('clinic_id', clinicId).eq('id', id).select().single();
  return data;
}

/** Mark a proposal executed, recording what Remi actually did. */
export async function markGrowthProposalSent(id: string, results: any) {
  const { data } = await supabase.from('growth_proposals')
    .update({ status: 'sent', sent_at: new Date().toISOString(), results })
    .eq('id', id).select().single();
  return data;
}

/** Approved proposals waiting to be executed by the scheduler. */
export async function getApprovedGrowthProposals(clinicId: string) {
  const { data } = await supabase.from('growth_proposals').select('*')
    .eq('clinic_id', clinicId).eq('status', 'approved')
    .order('decided_at', { ascending: true }).limit(50);
  return data ?? [];
}

// ---- Growth targeting queries ----------------------------------------------

/** Consented clients overdue vs their OWN visit cadence (needs ≥2 past visits to
 *  learn the rhythm). For cadence-aware win-backs — far better than a flat timer. */
export async function getCadenceOverdueClients(clinicId: string, bufferDays = 14, limit = 15) {
  const { data: clients } = await supabase
    .from('clients').select('id,name,phone,consent_at,last_reactivated_at')
    .eq('clinic_id', clinicId).not('consent_at', 'is', null).not('phone', 'is', null);
  if (!clients?.length) return [];
  const { data: bks } = await supabase
    .from('bookings').select('client_id,start_at').eq('clinic_id', clinicId)
    .in('client_id', clients.map((c) => c.id));
  const byClient: Record<string, number[]> = {};
  for (const b of bks ?? []) (byClient[b.client_id] ??= []).push(new Date(b.start_at).getTime());
  const now = Date.now();
  const reactCutoff = now - bufferDays * 86_400_000;
  const out: any[] = [];
  for (const c of clients) {
    const verdict = cadenceOverdue(byClient[c.id] ?? [], bufferDays, now);
    if (!verdict || !verdict.overdue) continue;
    if (c.last_reactivated_at && new Date(c.last_reactivated_at).getTime() >= reactCutoff) continue;
    out.push({ ...c, cadence_days: verdict.cadenceDays });
    if (out.length >= limit) break;
  }
  return out;
}

/** Consented clients who visited within `days` — for referral asks (recently
 *  served = most likely to be happy enough to refer). */
export async function getRecentlyVisitedClients(clinicId: string, days = 30, limit = 20) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await supabase
    .from('bookings').select('start_at, clients!inner(id,name,phone,consent_at)')
    .eq('clinic_id', clinicId).gte('start_at', since).lte('start_at', new Date().toISOString())
    .order('start_at', { ascending: false });
  const seen = new Set<string>(); const out: any[] = [];
  for (const b of (data ?? []) as any[]) {
    const c = b.clients;
    if (!c?.phone || !c.consent_at || seen.has(c.id)) continue;
    seen.add(c.id); out.push({ id: c.id, name: c.name ?? 'there', phone: c.phone });
    if (out.length >= limit) break;
  }
  return out;
}

/** All consented, contactable clients — for an off-peak broadcast. Capped. */
export async function getConsentedClients(clinicId: string, limit = 60) {
  const { data } = await supabase
    .from('clients').select('id,name,phone')
    .eq('clinic_id', clinicId).not('consent_at', 'is', null).not('phone', 'is', null)
    .order('created_at', { ascending: false }).limit(limit);
  return data ?? [];
}

// ---- Referral attribution --------------------------------------------------

/** Get (or lazily create) a client's personal referral code. */
export async function getOrCreateReferralCode(clientId: string): Promise<string> {
  const { data } = await supabase.from('clients').select('referral_code').eq('id', clientId).maybeSingle();
  if (data?.referral_code) return data.referral_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const { error } = await supabase.from('clients').update({ referral_code: code }).eq('id', clientId);
    if (!error) return code; // unique index makes a collision error; retry
  }
  throw new Error('could not allocate referral code');
}

export async function findClientByReferralCode(clinicId: string, code: string) {
  const { data } = await supabase.from('clients').select('id,name,phone')
    .eq('clinic_id', clinicId).eq('referral_code', code).maybeSingle();
  return data;
}

/**
 * Capture a referral from an inbound message: parse the code, find the referrer,
 * and record the attribution (idempotent — first attribution per friend wins, and
 * never self-refer). Returns the recorded referral, or null if nothing to capture.
 */
export async function captureReferralFromMessage(clinic: any, customer: any, text: string) {
  const code = extractReferralCode(text);
  if (!code) return null;
  const referrer = await findClientByReferralCode(clinic.id, code);
  if (!referrer || referrer.id === customer.id) return null; // unknown code or self-referral
  const reward = (clinic.growth_settings?.referral?.reward) || '';
  const { data } = await supabase.from('referrals').upsert({
    clinic_id: clinic.id, referrer_client_id: referrer.id, referred_client_id: customer.id,
    referred_phone: customer.phone ?? null, code, reward, status: 'pending',
  }, { onConflict: 'clinic_id,referred_client_id', ignoreDuplicates: true }).select().maybeSingle();
  return data ? { ...data, referrer } : null;
}

/** Mark a referred client's referral as 'booked' once they actually book. No-op
 *  if they weren't referred. */
export async function markReferralBooked(clinicId: string, referredClientId: string) {
  await supabase.from('referrals').update({ status: 'booked', booked_at: new Date().toISOString() })
    .eq('clinic_id', clinicId).eq('referred_client_id', referredClientId).eq('status', 'pending');
}

export async function listReferrals(clinicId: string) {
  const { data } = await supabase.from('referrals')
    .select('*, referrer:referrer_client_id(name,phone), referred:referred_client_id(name,phone)')
    .eq('clinic_id', clinicId).order('created_at', { ascending: false }).limit(100);
  return data ?? [];
}

export async function rewardReferral(clinicId: string, id: string) {
  const { data } = await supabase.from('referrals')
    .update({ status: 'rewarded', rewarded_at: new Date().toISOString() })
    .eq('clinic_id', clinicId).eq('id', id).select('*, referrer:referrer_client_id(name,phone)').maybeSingle();
  return data;
}
