// Pure reminder-scheduling math, split out from db.ts so it can be tested.

export interface ReminderRow {
  booking_id: string;
  kind: string;
  scheduled_for: string;
  status: 'pending';
}

const HOUR = 3_600_000;

/**
 * Build the reminder/outreach rows for a booking:
 *  - BEFORE the appointment: 48h, 24h, 2h reminders (only those still in the future)
 *  - AFTER the appointment: aftercare (+3h) and review request (+24h)
 * `now` is injectable for testing.
 */
export function buildReminderRows(
  bookingId: string,
  startAtISO: string,
  now: number = Date.now(),
): ReminderRow[] {
  const start = new Date(startAtISO).getTime();

  const rows: ReminderRow[] = ([['48h', 48], ['24h', 24], ['2h', 2]] as [string, number][])
    .filter(([, h]) => start - h * HOUR > now)
    .map(([kind, h]) => ({
      booking_id: bookingId,
      kind,
      scheduled_for: new Date(start - h * HOUR).toISOString(),
      status: 'pending',
    }));

  for (const [kind, h] of [['aftercare', 3], ['review', 24]] as [string, number][]) {
    rows.push({
      booking_id: bookingId,
      kind,
      scheduled_for: new Date(start + h * HOUR).toISOString(),
      status: 'pending',
    });
  }
  return rows;
}
