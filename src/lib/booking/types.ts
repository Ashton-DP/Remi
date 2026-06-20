// Provider-agnostic booking layer.
//
// Remi must connect to whatever booking system a clinic already uses. Every
// concrete integration (Google Calendar, Fresha, Acuity, Nookal, Cliniko, …)
// implements this one interface, and the rest of the app (slot finding, the
// create/reschedule/cancel tools) only ever talks to the interface — never to a
// specific provider. Adding a new provider is then a single new file + a line in
// the registry, with no change to the booking flow.

/** A block of time the diary is already taken. */
export interface BusyWindow {
  start: string; // ISO datetime
  end: string; // ISO datetime
}

/** Everything needed to put one appointment on a diary. */
export interface BookingEventInput {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  // Richer context that API-based providers (Acuity/Cliniko/Nookal) need to map
  // onto their own appointment-type / patient records. Google ignores these.
  service?: string; // clinic service name → provider appointment type
  clientId?: string; // Remi client id (for caching the provider's patient id)
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
}

/**
 * A booking back-end for a clinic. `clinic` is the Supabase clinics row — each
 * provider reads whatever config it needs from it (e.g. `google_calendar_id`,
 * or a future `fresha_location_id` / API token reference).
 */
export interface BookingProvider {
  /** Stable id, e.g. "google" | "fresha" | "acuity". */
  readonly name: string;

  /** Busy windows on the clinic's diary between two ISO datetimes. */
  getBusy(clinic: any, startISO: string, endISO: string): Promise<BusyWindow[]>;

  /**
   * Optional: providers whose API returns AVAILABLE slots directly (Acuity,
   * Cliniko, Nookal) implement this instead of relying on getBusy + local slot
   * maths. Returns ISO start times (clinic-local offset) for the given date.
   * When present, `computeFreeSlots` uses it and skips the busy-window path.
   */
  getAvailableSlots?(clinic: any, dateStr: string, service?: string): Promise<string[]>;

  /** Create an appointment. Returns the provider's event/booking id. */
  createEvent(clinic: any, input: BookingEventInput): Promise<{ id: string }>;

  /** Move an existing appointment to a new time. */
  updateEvent(clinic: any, eventId: string, input: BookingEventInput): Promise<void>;

  /** Remove an appointment from the diary. */
  cancelEvent(clinic: any, eventId: string): Promise<void>;
}
