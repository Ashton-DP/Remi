import { getBookingProvider } from './booking';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Returns the clinic timezone's UTC offset as e.g. "+02:00". */
function tzOffset(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    const m = part?.match(/GMT([+-]\d{2}:\d{2})/);
    return m?.[1] ?? '+00:00';
  } catch {
    return '+00:00';
  }
}

/**
 * Compute up to 5 open appointment slots on a given date for a service.
 * Slots are returned as ISO strings WITH the clinic's UTC offset (e.g.
 * "2026-06-18T09:00:00+02:00") so they display and book in clinic-local time.
 */
export async function computeFreeSlots(
  clinic: any,
  dateStr: string,
  service?: string,
): Promise<string[]> {
  const timeZone = clinic.timezone ?? 'Africa/Johannesburg';
  const offset = tzOffset(timeZone);
  const hours = clinic.hours_json ?? {};
  const weekday = WEEKDAYS[new Date(`${dateStr}T00:00:00${offset}`).getUTCDay()];
  const ranges: [string, string][] = hours[weekday] ?? [['09:00', '17:00']];

  const svc = (clinic.services_json ?? []).find(
    (s: any) => String(s.service).toLowerCase() === String(service ?? '').toLowerCase(),
  );
  const durationMin = svc?.duration_min ?? 30;

  const busy = await getBookingProvider(clinic).getBusy(
    clinic,
    new Date(`${dateStr}T00:00:00${offset}`).toISOString(),
    new Date(`${dateStr}T23:59:59${offset}`).toISOString(),
  );

  const slots: string[] = [];
  for (const [open, close] of ranges) {
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    let mins = oh * 60 + om;
    const closeMins = ch * 60 + cm;
    while (mins + durationMin <= closeMins) {
      const iso = `${dateStr}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00${offset}`;
      const slotStart = new Date(iso);
      const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
      const overlaps = busy.some(
        (b) => new Date(b.start) < slotEnd && new Date(b.end) > slotStart,
      );
      const inPast = slotStart.getTime() < Date.now();
      if (!overlaps && !inPast) slots.push(iso);
      mins += durationMin;
      if (slots.length >= 5) break;
    }
    if (slots.length >= 5) break;
  }
  return slots;
}
