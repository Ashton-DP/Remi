/**
 * Team Ops pure logic — hours math, split from db.ts so it's testable in Node
 * with no Supabase. Time entries are { clock_in, clock_out } ISO strings;
 * clock_out null means still clocked in.
 */
export interface TimeEntryLite {
  clock_in: string;
  clock_out: string | null;
}

const HOUR = 3_600_000;

/** Total worked hours across entries. Open entries count up to `now`. */
export function sumHours(entries: TimeEntryLite[], now: number = Date.now()): number {
  let ms = 0;
  for (const e of entries) {
    const start = new Date(e.clock_in).getTime();
    if (isNaN(start)) continue;
    const end = e.clock_out ? new Date(e.clock_out).getTime() : now;
    if (end > start) ms += end - start;
  }
  return Math.round((ms / HOUR) * 100) / 100; // 2dp hours
}

/** Monday 00:00 of the week containing `now`, as epoch ms (clinic-local-ish; UTC
 *  offset handled by caller via tz date string). Pure for testing. */
export function startOfWeek(now: number = Date.now()): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.getTime();
}

/** Human "3h 25m" from decimal hours. Pure. */
export function formatHours(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  if (whole && mins) return `${whole}h ${mins}m`;
  if (whole) return `${whole}h`;
  return `${mins}m`;
}

/** Inclusive day-count for a leave request (e.g. Mon–Fri = 5). Pure. */
export function leaveDays(startISO: string, endISO: string): number {
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  if (isNaN(s) || isNaN(e) || e < s) return 0;
  return Math.round((e - s) / (24 * HOUR)) + 1;
}
