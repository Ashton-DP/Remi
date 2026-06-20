import type { BookingProvider, BookingEventInput, BusyWindow } from './types';
import {
  getBusy as gcalGetBusy,
  createEvent as gcalCreateEvent,
  updateEvent as gcalUpdateEvent,
  deleteEvent as gcalDeleteEvent,
} from '../googleCalendar';

/**
 * Google Calendar adapter — the safe default. Works for ANY clinic without its
 * own booking API: Remi's calendar is the source of truth for the slots it
 * manages. A clinic can point at a dedicated calendar via `clinic.google_calendar_id`
 * (falls back to the global GOOGLE_CALENDAR_ID). With no Google credentials at
 * all, the underlying functions run in demo mode (open diary, demo event ids).
 */
export const googleProvider: BookingProvider = {
  name: 'google',

  getBusy(clinic: any, startISO: string, endISO: string): Promise<BusyWindow[]> {
    return gcalGetBusy(startISO, endISO, clinic?.google_calendar_id);
  },

  createEvent(clinic: any, input: BookingEventInput): Promise<{ id: string }> {
    return gcalCreateEvent({ ...input, calendarId: clinic?.google_calendar_id });
  },

  updateEvent(clinic: any, eventId: string, input: BookingEventInput): Promise<void> {
    return gcalUpdateEvent({
      eventId,
      startISO: input.startISO,
      endISO: input.endISO,
      calendarId: clinic?.google_calendar_id,
    });
  },

  cancelEvent(clinic: any, eventId: string): Promise<void> {
    return gcalDeleteEvent(eventId, clinic?.google_calendar_id);
  },
};
