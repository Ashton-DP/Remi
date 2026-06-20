import { createEvent } from '../lib/googleCalendar';
import { computeFreeSlots } from '../lib/slots';
import { sendProactiveWhatsApp } from '../lib/twilio';
import { createDepositCheckout, stripeEnabled } from '../lib/stripe';
import { config } from '../config';
import {
  createBookingRow, logEvent, createEscalation,
  scheduleReminders, getClientWaitlist, setWaitlistStatus,
  getNextBooking, setBookingStatus, rescheduleBooking,
  addWaitlist, getNextWaitlist, setBookingDepositStatus,
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
    case 'get_services':
      return { services: clinic.services_json ?? [] };

    case 'check_availability': {
      const slots = await computeFreeSlots(clinic, input.date, input.service);
      return { date: input.date, service: input.service, available_slots: slots };
    }

    case 'create_booking': {
      const svc = (clinic.services_json ?? []).find(
        (s: any) => String(s.service).toLowerCase() === String(input.service ?? '').toLowerCase(),
      );
      const durationMin = svc?.duration_min ?? 30;
      const start = new Date(input.start_at);
      const end = new Date(start.getTime() + durationMin * 60000);

      const ev = await createEvent({
        summary: `${input.service} — ${input.client_name}`,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        description: `Booked via Remi for ${customer.phone}`,
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

      // Deposit: if this clinic uses deposits + Stripe is configured, send a
      // payment link to secure the slot (big no-show reducer).
      let deposit_link: string | undefined;
      const depositZar = clinic.deposit_zar ?? 0;
      if (stripeEnabled && depositZar > 0 && booking?.id) {
        try {
          const url = await createDepositCheckout({
            amountZar: depositZar,
            bookingId: booking.id,
            clinicName: clinic.name,
            service: input.service,
          });
          if (url) {
            deposit_link = url;
            await setBookingDepositStatus(booking.id, 'requested');
            const when = start.toLocaleString('en-ZA', {
              timeZone: clinic.timezone ?? 'Africa/Johannesburg',
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            await sendProactiveWhatsApp(customer.phone, {
              fallbackBody: `To secure your ${input.service} on ${when}, please pay your R${depositZar} deposit here: ${url}`,
            });
          }
        } catch (e) {
          console.error('[deposit] error', e);
        }
      }

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

      await rescheduleBooking(existing.id, newStart.toISOString(), newEnd.toISOString());
      await scheduleReminders(existing.id, newStart.toISOString());

      return { ok: true, when: newStart.toISOString() };
    }

    case 'cancel_booking': {
      const existing = await getNextBooking(clinic.id, customer.id);
      if (!existing) return { error: 'No upcoming confirmed booking found to cancel.' };

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

    case 'escalate_to_human': {
      await createEscalation(convo.id, input.reason, input.summary);
      return { ok: true, message: 'A team member has been flagged and will follow up.' };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
