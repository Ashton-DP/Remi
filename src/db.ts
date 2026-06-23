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
