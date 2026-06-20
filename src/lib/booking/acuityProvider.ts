import type { BookingProvider, BookingEventInput } from './types';
import { need, findService, splitName, basic, httpJson } from './providerUtils';

// Acuity Scheduling adapter.
// Docs: https://developers.acuityscheduling.com/reference
// Auth: HTTP Basic — username = Acuity User ID, password = API Key.
// Base: https://acuityscheduling.com/api/v1
//
// ⚠️ UNTESTED against a live account. Endpoints/fields are taken from Acuity's
// published reference (verified June 2026). Verify with a real Acuity account
// before relying on it for a clinic.
//
// Clinic config (on the clinics row):
//   acuity_user_id, acuity_api_key
// Per-service mapping (on each services_json entry):
//   acuity_type_id      → Acuity appointmentTypeID  (required)
//   acuity_calendar_id  → Acuity calendarID         (optional; clinic.acuity_calendar_id as fallback)

const BASE = 'https://acuityscheduling.com/api/v1';
const NAME = 'acuity';

function auth(clinic: any): Record<string, string> {
  const user = need(NAME, 'acuity_user_id', clinic?.acuity_user_id);
  const key = need(NAME, 'acuity_api_key', clinic?.acuity_api_key);
  return { Authorization: basic(String(user), String(key)), 'Content-Type': 'application/json' };
}

function typeAndCalendar(clinic: any, service?: string): { typeId: string; calendarId?: string } {
  const svc = findService(clinic, service);
  const typeId = need(NAME, `acuity_type_id for service "${service}"`, svc?.acuity_type_id);
  const calendarId = svc?.acuity_calendar_id ?? clinic?.acuity_calendar_id;
  return { typeId: String(typeId), calendarId: calendarId ? String(calendarId) : undefined };
}

export const acuityProvider: BookingProvider = {
  name: NAME,

  // Required by the interface but unused — Acuity is availability-native.
  async getBusy() {
    return [];
  },

  async getAvailableSlots(clinic: any, dateStr: string, service?: string): Promise<string[]> {
    const { typeId, calendarId } = typeAndCalendar(clinic, service);
    const q = new URLSearchParams({ appointmentTypeID: typeId, date: dateStr });
    if (calendarId) q.set('calendarID', calendarId);
    if (clinic?.timezone) q.set('timezone', clinic.timezone);
    const data = await httpJson(NAME, `${BASE}/availability/times?${q}`, { headers: auth(clinic) });
    // Response: [{ time: "2026-06-22T09:00:00-0700" }, ...]
    return (Array.isArray(data) ? data : []).map((r: any) => r.time).filter(Boolean);
  },

  async createEvent(clinic: any, input: BookingEventInput): Promise<{ id: string }> {
    const { typeId, calendarId } = typeAndCalendar(clinic, input.service);
    const { firstName, lastName } = splitName(input.clientName);
    const body: Record<string, unknown> = {
      datetime: input.startISO,
      appointmentTypeID: Number(typeId),
      firstName,
      lastName,
      email: input.clientEmail ?? '',
      phone: input.clientPhone ?? '',
    };
    if (calendarId) body.calendarID = Number(calendarId);
    const res = await httpJson(NAME, `${BASE}/appointments?admin=true`, {
      method: 'POST',
      headers: auth(clinic),
      body: JSON.stringify(body),
    });
    return { id: String(res.id) };
  },

  async updateEvent(clinic: any, eventId: string, input: BookingEventInput): Promise<void> {
    // PUT /appointments/:id/reschedule  { datetime }
    await httpJson(NAME, `${BASE}/appointments/${eventId}/reschedule?admin=true`, {
      method: 'PUT',
      headers: auth(clinic),
      body: JSON.stringify({ datetime: input.startISO }),
    });
  },

  async cancelEvent(clinic: any, eventId: string): Promise<void> {
    // PUT /appointments/:id/cancel
    await httpJson(NAME, `${BASE}/appointments/${eventId}/cancel?admin=true`, {
      method: 'PUT',
      headers: auth(clinic),
      body: JSON.stringify({}),
    });
  },
};
