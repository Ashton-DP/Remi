import { supabase } from './lib/supabase';

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

// ---- Slice 2: reminders, cancellation/reschedule, waitlist, report ----

/** Schedule 48h/24h/2h reminders for a booking (only future ones). */
export async function scheduleReminders(bookingId: string, startAtISO: string) {
  const start = new Date(startAtISO).getTime();
  const kinds: [string, number][] = [
    ['48h', 48],
    ['24h', 24],
    ['2h', 2],
  ];
  const rows: any[] = kinds
    .filter(([, h]) => start - h * 3600000 > Date.now())
    .map(([kind, h]) => ({
      booking_id: bookingId,
      kind,
      scheduled_for: new Date(start - h * 3600000).toISOString(),
      status: 'pending',
    }));
  // After-appointment outreach: aftercare check-in (+3h) and review request (+24h).
  for (const [kind, h] of [['aftercare', 3], ['review', 24]] as [string, number][]) {
    rows.push({
      booking_id: bookingId,
      kind,
      scheduled_for: new Date(start + h * 3600000).toISOString(),
      status: 'pending',
    });
  }
  if (rows.length) await supabase.from('reminders').insert(rows);
}

/** Pending reminders that are due, with their booking + client embedded. */
export async function getDueReminders() {
  const { data } = await supabase
    .from('reminders')
    .select('id,kind,booking_id,bookings(service,start_at,status,clients(phone,name),clinics(name,google_review_url))')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString());
  return data ?? [];
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
export async function getOpenEscalations(clinicId: string) {
  const { data } = await supabase
    .from('escalations')
    .select('id,reason,summary,created_at,conversations(client_id,clients(phone,name))')
    .eq('status', 'open')
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
