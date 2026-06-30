import { getBookingProvider } from '../lib/booking';
import { computeFreeSlots } from '../lib/slots';
import { sendProactiveWhatsApp, sendMarketingWhatsApp } from '../lib/twilio';
import { intakeLink } from '../lib/intake';
import { config } from '../config';
import {
  createBookingRow, logEvent, createEscalation,
  scheduleReminders, getClientWaitlist, setWaitlistStatus,
  getNextBooking, setBookingStatus, rescheduleBooking,
  addWaitlist, getNextWaitlist, setBookingDepositStatus, setClientName,
  findConfirmedBooking, findClientBookingAround, setConversationStatus,
  getTodaysBookings, listWaitlist, getOverdueChasedInvoices,
  addTask, getActivePackage, decrementPackage, getClientMembership, markReferralBooked,
} from '../db';
import { sessionsRemaining } from '../lib/clientOs';

/** Executes a tool call and performs all side effects. Returns a JSON-able result. */
export async function executeTool(
  clinic: any,
  customer: any,
  convo: any,
  name: string,
  input: any,
): Promise<unknown> {
  switch (name) {
    case 'check_availability': {
      const slots = await computeFreeSlots(clinic, input.date, input.service);
      return { date: input.date, service: input.service, available_slots: slots };
    }

    case 'create_booking': {
      // Save the caller's name to their client record so it shows on the dashboard.
      if (input.client_name && !customer.name) {
        await setClientName(customer.id, input.client_name);
      }
      const svc = (clinic.services_json ?? []).find(
        (s: any) => String(s.service).toLowerCase() === String(input.service ?? '').toLowerCase(),
      );
      const durationMin = svc?.duration_min ?? 30;
      const start = new Date(input.start_at);
      const end = new Date(start.getTime() + durationMin * 60000);

      // Idempotency: if this client already has a confirmed booking at ~this time
      // (the model called create_booking twice, or a retry), return it instead of
      // creating a second event + row. Tolerant of exact-ISO/service mismatch so the
      // just-made booking is reliably recognised (the cause of the "slot taken" loop).
      const existingDup =
        (await findConfirmedBooking(clinic.id, customer.id, input.service, start.toISOString())) ||
        (await findClientBookingAround(clinic.id, customer.id, start.toISOString()));
      if (existingDup) {
        return { ok: true, booking_id: existingDup.id, when: existingDup.start_at, duplicate: true };
      }

      // Re-check the slot is STILL free right before booking — guards against
      // double-booking when two conversations confirm the same time, or the offered
      // slot list went stale. Fail-open on a provider error (don't block all
      // bookings on a hiccup); only reject when we have a fresh list that excludes it.
      try {
        const tz = clinic.timezone ?? 'Africa/Johannesburg';
        const localDate = start.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
        const freeSlots = await computeFreeSlots(clinic, localDate, input.service);
        const stillFree = freeSlots.some((s) => Math.abs(new Date(s).getTime() - start.getTime()) < 60_000);
        if (freeSlots.length && !stillFree) {
          // The slot shows taken — but if it's THIS client's own booking, it's a
          // duplicate call, not a clash. Return it instead of bouncing them.
          const own = await findClientBookingAround(clinic.id, customer.id, start.toISOString());
          if (own) return { ok: true, booking_id: own.id, when: own.start_at, duplicate: true };
          return { error: 'That time was just taken — could you pick another slot? Let me check what else is open.', slot_taken: true };
        }
      } catch (e) {
        console.error('[booking] availability re-check failed (allowing)', e);
      }

      const ev = await getBookingProvider(clinic).createEvent(clinic, {
        summary: `${input.service} — ${input.client_name}`,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        description: `Booked via Remi for ${customer.phone}`,
        service: input.service,
        clientId: customer.id,
        clientName: input.client_name ?? customer.name,
        clientEmail: customer.email,
        clientPhone: customer.phone,
      });

      const booking = await createBookingRow({
        clinicId: clinic.id,
        clientId: customer.id,
        service: input.service,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        calendarEventId: ev.id,
        source: 'whatsapp',
      });

      // Detect if this client was already on the waitlist (backfill scenario)
      const waitlistEntry = await getClientWaitlist(clinic.id, customer.id, input.service);
      const eventType = waitlistEntry ? 'slot_backfilled' : 'booking_created';
      await logEvent(
        clinic.id,
        eventType,
        svc?.price_zar || clinic.avg_new_client_value_zar || 0,
        booking?.id,
      );
      if (waitlistEntry) await setWaitlistStatus(waitlistEntry.id, 'filled');

      await scheduleReminders(booking?.id, start.toISOString());

      // Deposit (provider-agnostic): if this clinic has a deposit amount + their
      // own payment link configured, send it to secure the slot. Works with any
      // SA processor (Yoco/Paystack/PayFast/Stripe) — money goes to the clinic.
      let deposit_link: string | undefined;
      const depositZar = clinic.deposit_zar ?? 0;
      if (depositZar > 0 && clinic.deposit_link && booking?.id) {
        try {
          deposit_link = clinic.deposit_link;
          await setBookingDepositStatus(booking.id, 'requested');
          const when = start.toLocaleString('en-ZA', {
            timeZone: clinic.timezone ?? 'Africa/Johannesburg',
            dateStyle: 'medium',
            timeStyle: 'short',
          });
          await sendProactiveWhatsApp(customer.phone, {
            contentSid: config.templates.deposit || undefined,
            variables: { '1': input.service, '2': when, '3': String(depositZar), '4': deposit_link! },
            fallbackBody: `To secure your ${input.service} on ${when}, please pay your R${depositZar} deposit here: ${deposit_link}`,
          });
        } catch (e) {
          console.error('[deposit] error', e);
        }
      }

      // Treatment prep instructions — if this service (or the clinic) has prep
      // notes, send them so the patient arrives ready (no wasted appointments).
      const prep = svc?.prep || clinic.default_prep;
      if (prep && customer.phone) {
        try {
          const when = start.toLocaleString('en-ZA', {
            timeZone: clinic.timezone ?? 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short',
          });
          await sendProactiveWhatsApp(customer.phone, {
            fallbackBody: `✅ Booked: ${input.service} on ${when}.\n\nBefore your visit: ${prep}`,
          });
        } catch (e) {
          console.error('[prep] error', e);
        }
      }

      // First-time patient → send the digital intake form link to fill in before the visit.
      if (customer.id && !customer.intake_submitted_at && config.intake?.enabled && customer.phone) {
        try {
          const link = intakeLink(clinic.id, customer.id);
          await sendProactiveWhatsApp(customer.phone, {
            fallbackBody: `One quick thing — please fill in your details before your visit (2 min): ${link}`,
          });
        } catch (e) {
          console.error('[intake] error', e);
        }
      }

      // Mark the conversation booked so the follow-up job won't chase them.
      if (convo?.id) await setConversationStatus(convo.id, 'booked').catch(() => {});

      // If this client was referred, the referral has now converted → mark it booked.
      await markReferralBooked(clinic.id, customer.id).catch(() => {});

      // Decrement active prepaid package session if one exists.
      let package_sessions_remaining: number | undefined;
      try {
        const pkg = await getActivePackage(clinic.id, customer.id);
        if (pkg) {
          await decrementPackage(pkg.id);
          package_sessions_remaining = pkg.sessions_total - pkg.sessions_used - 1;
        }
      } catch (e) {
        console.error('[package] decrement error', e);
      }

      return { ok: true, booking_id: booking?.id, when: start.toISOString(), deposit_link, package_sessions_remaining };
    }

    case 'reschedule_booking': {
      const existing = await getNextBooking(clinic.id, customer.id);
      if (!existing) return { error: 'No upcoming confirmed booking found to reschedule.' };

      const svc = (clinic.services_json ?? []).find(
        (s: any) => String(s.service).toLowerCase() === String(existing.service ?? '').toLowerCase(),
      );
      const durationMin = svc?.duration_min ?? 30;
      const newStart = new Date(input.new_start_at);
      const newEnd = new Date(newStart.getTime() + durationMin * 60000);

      // Move the real diary FIRST; only update our DB if that succeeds, so the
      // two can't diverge (DB says moved while the clinic's calendar didn't).
      if (existing.calendar_event_id) {
        try {
          await getBookingProvider(clinic).updateEvent(clinic, existing.calendar_event_id, {
            summary: `${existing.service}`,
            service: existing.service,
            startISO: newStart.toISOString(),
            endISO: newEnd.toISOString(),
          });
        } catch (e) {
          console.error('[reschedule] calendar update failed', e);
          return { error: 'Could not move the appointment in the calendar. Please try again, or I can pass you to a team member.' };
        }
      }
      await rescheduleBooking(existing.id, newStart.toISOString(), newEnd.toISOString());
      await scheduleReminders(existing.id, newStart.toISOString());

      return { ok: true, when: newStart.toISOString() };
    }

    case 'cancel_booking': {
      const existing = await getNextBooking(clinic.id, customer.id);
      if (!existing) return { error: 'No upcoming confirmed booking found to cancel.' };

      // Free the slot on the clinic's actual diary FIRST. If that fails, don't
      // mark cancelled in our DB and don't offer the slot to the waitlist — else
      // we'd promise a slot that's still booked on the real calendar.
      if (existing.calendar_event_id) {
        try {
          await getBookingProvider(clinic).cancelEvent(clinic, existing.calendar_event_id);
        } catch (e) {
          console.error('[cancel] calendar delete failed', e);
          return { error: 'Could not cancel the appointment in the calendar. Please try again, or I can pass you to a team member.' };
        }
      }
      await setBookingStatus(existing.id, 'cancelled');

      // Offer freed slot to the next person on the waitlist for this service
      const waiter = await getNextWaitlist(clinic.id, existing.service);
      if (waiter) {
        const waiterClient = (waiter as any).clients;
        if (waiterClient?.phone) {
          const when = new Date(existing.start_at).toLocaleString('en-ZA', {
            timeZone: clinic.timezone ?? 'Africa/Johannesburg',
            dateStyle: 'medium',
            timeStyle: 'short',
          });
          await sendMarketingWhatsApp(clinic.id, waiterClient.phone, {
            contentSid: config.templates.waitlistOffer || undefined,
            variables: { '1': waiterClient.name ?? 'there', '2': existing.service, '3': when },
            fallbackBody: `Hi ${waiterClient.name ?? 'there'}! A slot just opened for ${existing.service} on ${when}. Would you like to book it? Reply YES and we'll confirm it for you.`,
          });
          await setWaitlistStatus(waiter.id, 'offered');
        }
      }

      return { ok: true, cancelled: true, waitlist_notified: Boolean(waiter) };
    }

    case 'add_to_waitlist': {
      await addWaitlist(clinic.id, customer.id, input.service, input.preferred_window);
      return {
        ok: true,
        message: `Added to waitlist for ${input.service}. We'll text you as soon as a slot opens.`,
      };
    }

    case 'get_daily_brief': {
      const tz = clinic.timezone ?? 'Africa/Johannesburg';
      const [bookings, waitlist, overdue] = await Promise.all([
        getTodaysBookings(clinic.id, tz),
        listWaitlist(clinic.id),
        getOverdueChasedInvoices(clinic.id),
      ]);
      const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const appts = bookings.map((b: any) => ({
        time: fmt(b.start_at),
        client: b.clients?.name ?? 'Unknown',
        service: b.service,
        status: b.status,
      }));
      const waiting = waitlist.map((w: any) => ({
        client: w.clients?.name ?? 'Unknown',
        service: w.service,
        window: w.preferred_window ?? 'any time',
      }));
      return {
        date: new Date().toLocaleDateString('en-ZA', { timeZone: tz, dateStyle: 'full' }),
        total_appointments: appts.length,
        appointments: appts,
        waitlist_count: waiting.length,
        waitlist: waiting,
        overdue_invoices: overdue.length,
      };
    }

    case 'escalate_to_human': {
      await createEscalation(convo.id, input.reason, input.summary);
      // Real-time alert to the clinic owner so a human can pick it up promptly.
      const ownerTo = clinic.owner_summary_phone || clinic.escalation_contact;
      if (ownerTo) {
        try {
          await sendProactiveWhatsApp(ownerTo, {
            fallbackBody: `🔔 Remi needs a human at ${clinic.name}.\nFrom: ${customer.name ?? customer.phone}\nReason: ${input.reason ?? 'n/a'}\n${input.summary ?? ''}`.trim(),
          });
        } catch (e) {
          console.error('[escalation alert] failed', e);
        }
      }
      return { ok: true, message: 'A team member has been flagged and will follow up.' };
    }

    case 'take_message': {
      const who = String(input.for_whom ?? '').trim();
      const body = String(input.message ?? '').trim();
      if (!body) return { error: 'Nothing to pass on yet — what is the message?' };
      const from = customer.name ?? customer.phone ?? 'a caller';
      const title = who ? `Message for ${who} — from ${from}` : `Message from ${from}`;
      const note = `${body}${input.callback_wanted ? `\n\nWants a callback on ${customer.phone ?? '(no number)'}.` : ''}`;
      await addTask(clinic.id, { title, note, assignee: who || undefined, source: 'whatsapp-client' });
      return { ok: true, message: "Got it — I've passed that on to the team." };
    }

    case 'check_package': {
      const pkg = await getActivePackage(clinic.id, customer.id);
      if (!pkg) return { has_package: false, message: 'No active prepaid package found on your account.' };
      const remaining = sessionsRemaining(pkg);
      const expiry = pkg.expires_at
        ? new Date(pkg.expires_at).toLocaleDateString('en-ZA', { dateStyle: 'medium' })
        : null;
      return { has_package: true, name: pkg.name, sessions_remaining: remaining, sessions_total: pkg.sessions_total, expires: expiry };
    }

    case 'check_membership': {
      const m = await getClientMembership(clinic.id, customer.id);
      if (!m) return { is_member: false, message: 'No active membership found on your account.' };
      const renews = m.renews_at
        ? new Date(m.renews_at).toLocaleDateString('en-ZA', { dateStyle: 'medium' })
        : null;
      return { is_member: true, plan: m.plan_name, status: m.status, renews_on: renews };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
