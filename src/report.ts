/**
 * "R recovered" report — run with: npm run report
 * Also exported for the GET /report/:clinicId HTTP route.
 */
import { config } from './config';
import { getClinic, getReportData } from './db';

export interface ReportStats {
  bookedN: number;
  bookedR: number;
  recoveredR: number;
  backfillN: number;
  escalations: number;
  confirmed: number;
  cancelled: number;
  noShowRate: number;
}

/** Pure aggregation of report numbers from raw events + bookings (testable). */
export function computeReportStats(events: any[], bookings: any[]): ReportStats {
  const evs = events ?? [];
  const bks = bookings ?? [];
  const sumR = (type: string) =>
    evs.filter((e) => e.type === type).reduce((a, e) => a + (e.value_zar || 0), 0);
  const countE = (type: string) => evs.filter((e) => e.type === type).length;

  const confirmed = bks.filter((b) => b.status === 'confirmed').length;
  const cancelled = bks.filter((b) => b.status === 'cancelled').length;
  return {
    bookedN: countE('booking_created') + countE('slot_backfilled'),
    bookedR: sumR('booking_created') + sumR('slot_backfilled'),
    recoveredR: sumR('missed_call_recovered') + sumR('slot_backfilled'),
    backfillN: countE('slot_backfilled'),
    escalations: countE('escalation_created'),
    confirmed,
    cancelled,
    noShowRate:
      confirmed + cancelled > 0 ? Math.round((cancelled / (confirmed + cancelled)) * 100) : 0,
  };
}

export async function generateReport(clinicId: string, sinceDays = 30): Promise<string> {
  const clinic = await getClinic(clinicId);
  if (!clinic) return `Clinic not found: ${clinicId}`;

  const sinceISO = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { events, bookings } = await getReportData(clinicId, sinceISO);

  const { bookedN, bookedR, recoveredR, backfillN, escalations, confirmed, cancelled, noShowRate } =
    computeReportStats(events as any[], bookings as any[]);

  return [
    `=== Remi Report — ${clinic.name} ===`,
    `Period: last ${sinceDays} days (since ${sinceISO.slice(0, 10)})`,
    ``,
    `💰 Revenue via Remi`,
    `   Bookings made:       ${bookedN.toString().padStart(3)}  (R${bookedR.toLocaleString()})`,
    `   Waitlist backfills:  ${backfillN.toString().padStart(3)}`,
    `   Recovered value:     R${recoveredR.toLocaleString()}`,
    ``,
    `📋 Booking status (all time in period)`,
    `   Confirmed:  ${confirmed}`,
    `   Cancelled:  ${cancelled}  (${noShowRate}% cancellation rate)`,
    ``,
    `⚡ Escalated to human: ${escalations}`,
    ``,
    `Generated: ${new Date().toLocaleString('en-ZA', { timeZone: clinic.timezone ?? 'Africa/Johannesburg' })}`,
  ].join('\n');
}

// CLI: npm run report
if (require.main === module) {
  const clinicId = config.defaultClinicId;
  if (!clinicId) {
    console.error('Set DEFAULT_CLINIC_ID in .env');
    process.exit(1);
  }
  const days = parseInt(process.argv[2] ?? '30', 10);
  generateReport(clinicId, days).then(console.log).catch(console.error);
}
