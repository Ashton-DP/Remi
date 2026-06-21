import type { BookingProvider, BookingEventInput } from './types';
import { need, findService, splitName, httpJson } from './providerUtils';

// Nookal adapter.
// Docs: https://api.nookal.com/dev
// Auth: api_key as a query/body param + x-api-key header. Each key maps to one
//   Nookal location.
// Base: https://api.nookal.com/production/v2/<method>
// Responses are status-wrapped: { status: "success", data: { results: {...} } }.
//
// ⚠️ UNTESTED against a live account. Method names/params verified against the
// Nookal reference (June 2026). The availability response parsing and the
// find-or-create patient step especially need checking against a real account.
//
// Clinic config (clinics row):
//   nookal_api_key, nookal_location_id, nookal_practitioner_id (default)
// Per-service (services_json entry):
//   nookal_appointment_type_id (required)

const NAME = 'nookal';
const BASE = 'https://api.nookal.com/production/v2';

function key(clinic: any): string {
  return String(need(NAME, 'nookal_api_key', clinic?.nookal_api_key));
}
function headers(clinic: any): Record<string, string> {
  return { 'x-api-key': key(clinic), 'Content-Type': 'application/x-www-form-urlencoded' };
}
function ids(clinic: any, service?: string) {
  const svc = findService(clinic, service);
  return {
    locationId: String(need(NAME, 'nookal_location_id', clinic?.nookal_location_id)),
    practitionerId: String(need(NAME, 'nookal_practitioner_id', clinic?.nookal_practitioner_id)),
    appointmentTypeId: String(
      need(NAME, `nookal_appointment_type_id for service "${service}"`, svc?.nookal_appointment_type_id),
    ),
  };
}

/** POST a Nookal method with form params (api_key always included). */
async function call(clinic: any, method: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ api_key: key(clinic), ...params });
  const data = await httpJson(NAME, `${BASE}/${method}`, {
    method: 'POST',
    headers: headers(clinic),
    body: body.toString(),
  });
  if (data?.status && data.status !== 'success') {
    throw new Error(`[booking:${NAME}] ${method} → ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data?.data?.results ?? data?.data ?? data;
}

/**
 * Convert any ISO instant into the clinic's LOCAL wall-clock date + time, which
 * is what Nookal's appointment_date / start_time expect. executeTool passes a
 * UTC ISO, so naive string slicing booked appointments at the wrong hour (and
 * sometimes the wrong day) — this fixes that.
 */
function dateTime(iso: string, timeZone: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA', { timeZone }), // YYYY-MM-DD
    time: d.toLocaleTimeString('en-GB', { timeZone, hour12: false }), // HH:mm:ss
  };
}

/** Create a Nookal patient and return its id. TODO: add search-based dedup once
 *  verified against a live account (getPatients filtering is account-specific). */
async function createPatient(clinic: any, input: BookingEventInput): Promise<string> {
  const { firstName, lastName } = splitName(input.clientName);
  const res = await call(clinic, 'addPatient', {
    FirstName: firstName,
    LastName: lastName,
    ...(input.clientEmail ? { Email: input.clientEmail } : {}),
    ...(input.clientPhone ? { Mobile: input.clientPhone } : {}),
  });
  const id = res?.patient_id ?? res?.patients?.[0]?.ID ?? res?.ID;
  return String(need(NAME, 'patient id after create', id));
}

export const nookalProvider: BookingProvider = {
  name: NAME,

  async getBusy() {
    return [];
  },

  async getAvailableSlots(clinic: any, dateStr: string, service?: string): Promise<string[]> {
    const { locationId, practitionerId } = ids(clinic, service);
    const res = await call(clinic, 'getAppointmentAvailabilities', {
      location_id: locationId,
      practitioner_id: practitionerId,
      date_from: dateStr,
      date_to: dateStr,
    });
    // Response shape varies by account; defensively pull {date,time}|{start} pairs.
    const rows: any[] = res?.availabilities ?? res?.slots ?? (Array.isArray(res) ? res : []);
    return rows
      .map((r: any) => r.start ?? (r.date && r.time ? `${r.date}T${r.time}` : null))
      .filter(Boolean);
  },

  async createEvent(clinic: any, input: BookingEventInput): Promise<{ id: string }> {
    const { locationId, practitionerId, appointmentTypeId } = ids(clinic, input.service);
    const patientId = await createPatient(clinic, input);
    const { date, time } = dateTime(input.startISO, clinic.timezone ?? 'Africa/Johannesburg');
    const res = await call(clinic, 'addAppointmentBooking', {
      location_id: locationId,
      practitioner_id: practitionerId,
      appointment_type_id: appointmentTypeId,
      patient_id: patientId,
      appointment_date: date,
      start_time: time,
    });
    const id = res?.appointment_id ?? res?.booking_id ?? res?.ID;
    return { id: String(need(NAME, 'appointment id', id)) };
  },

  async updateEvent(clinic: any, eventId: string, input: BookingEventInput): Promise<void> {
    const { date, time } = dateTime(input.startISO, clinic.timezone ?? 'Africa/Johannesburg');
    await call(clinic, 'updateAppointmentBooking', {
      appointment_id: eventId,
      appointment_date: date,
      start_time: time,
    });
  },

  async cancelEvent(clinic: any, eventId: string): Promise<void> {
    // Nookal's cancelAppointment requires patient_id; we don't have it here, so
    // use updateAppointmentBooking to mark the booking cancelled instead.
    await call(clinic, 'updateAppointmentBooking', { appointment_id: eventId, status: 'cancelled' });
  },
};
