import { google } from 'googleapis';
import { config } from '../config';

function getCalendar() {
  if (!config.google.serviceAccountJson) return null;
  const creds = JSON.parse(
    Buffer.from(config.google.serviceAccountJson, 'base64').toString('utf8'),
  );
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

/** Resolve which calendar to use — a clinic-specific id if given, else the default. */
function calId(calendarId?: string): string {
  return calendarId || config.google.calendarId;
}

/** The service account's email — a clinic must share their calendar with this. */
export function serviceAccountEmail(): string | null {
  if (!config.google.serviceAccountJson) return null;
  try {
    const creds = JSON.parse(Buffer.from(config.google.serviceAccountJson, 'base64').toString('utf8'));
    return creds.client_email ?? null;
  } catch {
    return null;
  }
}

/** Verify a calendar is reachable (shared with the service account + valid id). */
export async function testCalendar(calendarId?: string): Promise<{ ok: boolean; error?: string }> {
  const cal = getCalendar();
  if (!cal) return { ok: false, error: 'Google not configured on the server.' };
  try {
    const now = new Date();
    await getBusy(now.toISOString(), new Date(now.getTime() + 3600_000).toISOString(), calendarId);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.errors?.[0]?.message || e?.message || 'Could not read the calendar.' };
  }
}

export interface BusyWindow {
  start: string;
  end: string;
}

/** Return busy windows on the calendar between two ISO datetimes. */
export async function getBusy(
  startISO: string,
  endISO: string,
  calendarId?: string,
): Promise<BusyWindow[]> {
  const cal = getCalendar();
  if (!cal) return []; // no calendar configured → treat as fully open (demo mode)
  const id = calId(calendarId);
  const res = await cal.freebusy.query({
    requestBody: { timeMin: startISO, timeMax: endISO, items: [{ id }] },
  });
  return (res.data.calendars?.[id]?.busy ?? []) as BusyWindow[];
}

/** Create a calendar event. Returns the event id (or a demo id if unconfigured). */
export async function createEvent(opts: {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  calendarId?: string;
}): Promise<{ id: string }> {
  const cal = getCalendar();
  if (!cal) return { id: 'demo-no-calendar' };
  const res = await cal.events.insert({
    calendarId: calId(opts.calendarId),
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startISO },
      end: { dateTime: opts.endISO },
    },
  });
  return { id: res.data.id ?? 'unknown' };
}

/** Move an existing event to a new time (used on reschedule). No-op in demo mode. */
export async function updateEvent(opts: {
  eventId: string;
  startISO: string;
  endISO: string;
  calendarId?: string;
}): Promise<void> {
  const cal = getCalendar();
  if (!cal || !opts.eventId || opts.eventId === 'demo-no-calendar') return;
  await cal.events.patch({
    calendarId: calId(opts.calendarId),
    eventId: opts.eventId,
    requestBody: {
      start: { dateTime: opts.startISO },
      end: { dateTime: opts.endISO },
    },
  });
}

/** Delete an event from the calendar (used on cancel). No-op in demo mode. */
export async function deleteEvent(eventId: string, calendarId?: string): Promise<void> {
  const cal = getCalendar();
  if (!cal || !eventId || eventId === 'demo-no-calendar') return;
  await cal.events.delete({ calendarId: calId(calendarId), eventId });
}
