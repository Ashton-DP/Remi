import { getBookingProvider } from '../lib/booking';
import { computeFreeSlots } from '../lib/slots';
import { sendProactiveWhatsApp } from '../lib/twilio';
import { intakeLink } from '../lib/intake';
import { config } from '../config';
import {
  createBookingRow, logEvent, createEscalation,
  scheduleReminders, getClientWaitlist, setWaitlistStatus,
  getNextBooking, setBookingStatus, rescheduleBooking,
  addWaitlist, getNextWaitlist, setBookingDepositStatus, setClientName,
  findConfirmedBooking, setConversationStatus,
  getTodaysBookings, listWaitlist, getOverdueChasedInvoices,
} from '../db';

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

      // Idempotency: if this exact appointment is already booked (e.g. a retried
      // request, or the model calling the tool twice), return it instead of
      // creating a second calendar event + DB row.
      const existingDup = await findConfirmedBooking(
        clinic.id, customer.id, input.service, start.toISOString(),
      );
      if (existingDup) {
        return { ok: true, booking_id: existingDup.id, when: existingDup.start_at, duplicate: true };
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

      return { ok: true, booking_id: booking?.id, when: start.toISOString(), deposit_link };
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
          await sendProactiveWhatsApp(waiterClient.phone, {
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

    default:
      return { error: `unknown tool: ${name}` };
  }
}
