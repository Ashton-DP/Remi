import type { BookingProvider, BookingEventInput } from './types';
import { need, findService, splitName, basic, httpJson } from './providerUtils';

// Cliniko adapter.
// Docs: https://docs.api.cliniko.com/
// Auth: HTTP Basic — username = API key, blank password. A descriptive
//   User-Agent header is REQUIRED ("App name (contact email)").
// Base: https://api.{shard}.cliniko.com/v1  — the shard is the suffix of the API
//   key after the last "-" (e.g. "...-au1" → shard "au1").
//
// ⚠️ UNTESTED against a live account. Endpoints verified against Cliniko's
// published OpenAPI (June 2026). The find-or-create patient step in particular
// must be checked against a real account.
//
// Clinic config (clinics row):
//   cliniko_api_key, cliniko_business_id, cliniko_practitioner_id (default)
// Per-service (services_json entry):
//   cliniko_appointment_type_id (required), cliniko_practitioner_id (optional override)

const NAME = 'cliniko';
const USER_AGENT = 'Remi (hello@remireception.com)';

function shardBase(apiKey: string): string {
  const shard = apiKey.includes('-') ? apiKey.split('-').pop() : 'au1';
  return `https://api.${shard}.cliniko.com/v1`;
}

function ctx(clinic: any) {
  const apiKey = String(need(NAME, 'cliniko_api_key', clinic?.cliniko_api_key));
  return {
    base: shardBase(apiKey),
    headers: {
      Authorization: basic(apiKey, ''),
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    } as Record<string, string>,
  };
}

function ids(clinic: any, service?: string) {
  const svc = findService(clinic, service);
  return {
    businessId: String(need(NAME, 'cliniko_business_id', clinic?.cliniko_business_id)),
    appointmentTypeId: String(
      need(NAME, `cliniko_appointment_type_id for service "${service}"`, svc?.cliniko_appointment_type_id),
    ),
    practitionerId: String(
      need(NAME, 'cliniko_practitioner_id', svc?.cliniko_practitioner_id ?? clinic?.cliniko_practitioner_id),
    ),
  };
}

/** Find a patient by email/phone, or create one. Returns the Cliniko patient id. */
async function findOrCreatePatient(clinic: any, input: BookingEventInput): Promise<string> {
  const { base, headers } = ctx(clinic);
  const { firstName, lastName } = splitName(input.clientName);

  if (input.clientEmail) {
    const q = `q[]=${encodeURIComponent(`email_address:=:${input.clientEmail}`)}`;
    const found = await httpJson(NAME, `${base}/patients?${q}`, { headers });
    const hit = found?.patients?.[0];
    if (hit?.id) return String(hit.id);
  }

  const created = await httpJson(NAME, `${base}/patients`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      email: input.clientEmail || undefined,
      patient_phone_numbers: input.clientPhone
        ? [{ phone_type: 'Mobile', number: input.clientPhone }]
        : undefined,
    }),
  });
  return String(need(NAME, 'patient id after create', created?.id));
}

export const clinikoProvider: BookingProvider = {
  name: NAME,

  async getBusy() {
    return [];
  },

  async getAvailableSlots(clinic: any, dateStr: string, service?: string): Promise<string[]> {
    const { base, headers } = ctx(clinic);
    const { businessId, appointmentTypeId, practitionerId } = ids(clinic, service);
    const q = new URLSearchParams({ from: dateStr, to: dateStr });
    const url = `${base}/businesses/${businessId}/practitioners/${practitionerId}/appointment_types/${appointmentTypeId}/available_times?${q}`;
    const data = await httpJson(NAME, url, { headers });
    // Response: { available_times: [{ appointment_start: "2026-06-22T09:00:00Z" }, ...] }
    return (data?.available_times ?? []).map((t: any) => t.appointment_start).filter(Boolean);
  },

  async createEvent(clinic: any, input: BookingEventInput): Promise<{ id: string }> {
    const { base, headers } = ctx(clinic);
    const { businessId, appointmentTypeId, practitionerId } = ids(clinic, input.service);
    const patientId = await findOrCreatePatient(clinic, input);
    const res = await httpJson(NAME, `${base}/individual_appointments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        patient_id: patientId,
        practitioner_id: practitionerId,
        appointment_type_id: appointmentTypeId,
        business_id: businessId,
        starts_at: input.startISO,
        ends_at: input.endISO,
      }),
    });
    return { id: String(need(NAME, 'appointment id', res?.id)) };
  },

  async updateEvent(clinic: any, eventId: string, input: BookingEventInput): Promise<void> {
    const { base, headers } = ctx(clinic);
    await httpJson(NAME, `${base}/individual_appointments/${eventId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ starts_at: input.startISO, ends_at: input.endISO }),
    });
  },

  async cancelEvent(clinic: any, eventId: string): Promise<void> {
    const { base, headers } = ctx(clinic);
    // PATCH /individual_appointments/:id/cancel
    await httpJson(NAME, `${base}/individual_appointments/${eventId}/cancel`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ cancellation_reason: 0, cancellation_note: 'Cancelled via Remi' }),
    });
  },
};
