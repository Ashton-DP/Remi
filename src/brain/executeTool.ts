import { createEvent } from '../lib/googleCalendar';
import { computeFreeSlots } from '../lib/slots';
import { createBookingRow, logEvent, createEscalation } from '../db';

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

      await logEvent(
        clinic.id,
        'booking_created',
        svc?.price_zar || clinic.avg_new_client_value_zar || 0,
        booking?.id,
      );

      return { ok: true, booking_id: booking?.id, when: start.toISOString() };
    }

    case 'escalate_to_human': {
      await createEscalation(convo.id, input.reason, input.summary);
      return { ok: true, message: 'A team member has been flagged and will follow up.' };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
