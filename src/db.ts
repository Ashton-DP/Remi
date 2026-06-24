import { supabase } from './lib/supabase';
import { buildReminderRows } from './lib/reminders';

export async function getClinic(id: string) {
  const { data } = await supabase.from('clinics').select('*').eq('id', id).single();
  return data;
}

/** Look up a clinic by its Twilio number (voice or WhatsApp). */
export async function getClinicByNumber(to: string) {
  const number = to.replace(/^whatsapp:/, ''); // strip prefix if present
  const { data } = await supabase.from('clinics').select('*').eq('twilio_number', number).maybeSingle();
  return data ?? null;
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
  const { data } = await supabase
    .from('messages')
    .select('direction,body')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);
  return (data ?? []).map((m: any) => ({
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
    .select('id,kind,booking_id,bookings(service,start_at,status,clients(phone,name),clinics(name,google_review_url))')
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
export async function getTodaysBookings(clinicId: string, timeZone = 'Africa/Johannesburg') {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD clinic-local
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value;
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
}) {
  const { data, error } = await supabase
    .from('clinics')
    .insert({
      name: obj.name,
      timezone: obj.timezone ?? 'Africa/Johannesburg',
      hours_json: obj.hours_json ?? null,
      services_json: obj.services_json ?? null,
      faq_json: obj.faq_json ?? null,
      owner_summary_phone: obj.owner_summary_phone ?? null,
      escalation_contact: obj.escalation_contact ?? null,
      knowledge: obj.knowledge ?? null,
      dashboard_token: obj.dashboard_token,
      booking_provider: 'google',
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data;
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
  return data ?? [];
}

/** Persist refreshed OAuth tokens / config for a clinic's invoice source. */
export async function setInvoiceSourceData(clinicId: string, patch: { tokens?: any; config?: any }) {
  const update: any = {};
  if (patch.tokens !== undefined) update.invoice_source_tokens = patch.tokens;
  if (patch.config !== undefined) update.invoice_source_config = patch.config;
  if (!Object.keys(update).length) return;
  const { error } = await supabase.from('clinics').update(update).eq('id', clinicId);
  if (error) throw new Error(`setInvoiceSourceData: ${error.message}`);
}

/** Connect a clinic to a source (called from the OAuth callback / sheet setup). */
export async function setInvoiceSource(clinicId: string, source: string, tokens: any, config: any) {
  const { error } = await supabase.from('clinics').update({
    invoice_source: source,
    invoice_source_tokens: tokens,
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
  await supabase.from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'overdue');
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
  const ALLOWED = ['name', 'timezone', 'knowledge', 'owner_summary_phone', 'escalation_contact', 'default_prep', 'chase_cadence', 'chase_reply_to'];
  const update: Record<string, any> = {};
  for (const k of ALLOWED) if (k in patch) update[k] = patch[k];
  if (!Object.keys(update).length) return;
  const { error } = await supabase.from('clinics').update(update).eq('id', clinicId);
  if (error) throw new Error(`updateClinicSettings: ${error.message}`);
}

/** Set a clinic's payment provider + its credentials (Settings → Connections). */
export async function setPaymentConfig(clinicId: string, provider: string, config: any) {
  const { error } = await supabase.from('clinics')
    .update({ payment_provider: provider, payment_config: config }).eq('id', clinicId);
  if (error) throw new Error(`setPaymentConfig: ${error.message}`);
}
