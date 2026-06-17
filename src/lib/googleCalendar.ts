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

export interface BusyWindow {
  start: string;
  end: string;
}

/** Return busy windows on the calendar between two ISO datetimes. */
export async function getBusy(startISO: string, endISO: string): Promise<BusyWindow[]> {
  const cal = getCalendar();
  if (!cal) return []; // no calendar configured → treat as fully open (demo mode)
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      items: [{ id: config.google.calendarId }],
    },
  });
  return (res.data.calendars?.[config.google.calendarId]?.busy ?? []) as BusyWindow[];
}

/** Create a calendar event. Returns the event id (or a demo id if unconfigured). */
export async function createEvent(opts: {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
}): Promise<{ id: string }> {
  const cal = getCalendar();
  if (!cal) return { id: 'demo-no-calendar' };
  const res = await cal.events.insert({
    calendarId: config.google.calendarId,
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startISO },
      end: { dateTime: opts.endISO },
    },
  });
  return { id: res.data.id ?? 'unknown' };
}
