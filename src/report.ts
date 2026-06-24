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

/** Pure builder for the morning team huddle message (testable). */
export function buildHuddle(
  bookings: any[],
  clinicName: string,
  timeZone = 'Africa/Johannesburg',
  intakeEnabled = false,
): string {
  const bks = bookings ?? [];
  if (bks.length === 0) return `☀️ Good morning! No appointments booked at ${clinicName} today. A good day to catch up. 🙂`;
  const lines = bks.map((b) => {
    const t = new Date(b.start_at).toLocaleTimeString('en-ZA', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
    const who = b.clients?.name ?? 'Unknown';
    const flag = intakeEnabled && b.clients && !b.clients.intake_submitted_at ? ' ⚠️ intake pending' : '';
    return `${t} · ${b.service} · ${who}${flag}`;
  });
  return `☀️ Good morning! ${bks.length} appointment${bks.length === 1 ? '' : 's'} at ${clinicName} today:\n\n${lines.join('\n')}`;
}

const escHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * Branded, shareable "Revenue Recovered" report page (HTML). This is the
 * anti-churn artifact — the headline number proves Remi pays for itself. Sent to
 * the clinic owner monthly with a link.
 */
export async function renderReportPage(clinicId: string, sinceDays = 30): Promise<string> {
  const clinic = await getClinic(clinicId);
  if (!clinic) return '<h1>Clinic not found</h1>';
  const sinceISO = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { events, bookings } = await getReportData(clinicId, sinceISO);
  const s = computeReportStats(events as any[], bookings as any[]);
  const R = (n: number) => 'R' + n.toLocaleString('en-ZA');
  const name = escHtml(clinic.name);
  const period = `${sinceDays} days`;
  const generated = new Date().toLocaleDateString('en-ZA', {
    timeZone: clinic.timezone ?? 'Africa/Johannesburg', dateStyle: 'medium',
  });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remi — Revenue Recovered · ${name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f7fb;color:#1e2233;padding:24px}
  .wrap{max-width:680px;margin:0 auto}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .dot{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#6c63ff,#4ecdc4);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800}
  .head b{font-size:18px}
  .sub{color:#64748b;font-size:13px;margin-bottom:24px}
  .hero{background:linear-gradient(135deg,#6c63ff,#5b4fcc);color:#fff;border-radius:18px;padding:32px;text-align:center;margin-bottom:20px}
  .hero .lbl{font-size:14px;opacity:.9;text-transform:uppercase;letter-spacing:.5px}
  .hero .big{font-size:48px;font-weight:800;margin:6px 0}
  .hero .note{font-size:14px;opacity:.92}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:20px}
  .card{background:#fff;border:1px solid #e6e8f0;border-radius:14px;padding:18px}
  .card .v{font-size:26px;font-weight:800;color:#6c63ff}
  .card .k{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px}
  .foot{color:#94a3b8;font-size:12px;text-align:center;margin-top:24px}
</style></head><body><div class="wrap">
  <div class="head"><div class="dot">R</div><b>${name}</b></div>
  <div class="sub">Your Remi report · last ${period}</div>
  <div class="hero">
    <div class="lbl">Revenue Remi captured for you</div>
    <div class="big">${R(s.bookedR)}</div>
    <div class="note">across ${s.bookedN} booking${s.bookedN === 1 ? '' : 's'}${s.recoveredR > 0 ? ` · ${R(s.recoveredR)} recovered from missed calls & cancellations` : ''}</div>
  </div>
  <div class="grid">
    <div class="card"><div class="v">${s.bookedN}</div><div class="k">Bookings via Remi</div></div>
    <div class="card"><div class="v">${s.confirmed}</div><div class="k">Confirmed</div></div>
    <div class="card"><div class="v">${R(s.recoveredR)}</div><div class="k">Recovered value</div></div>
    <div class="card"><div class="v">${s.backfillN}</div><div class="k">Waitlist backfills</div></div>
    <div class="card"><div class="v">${s.cancelled}</div><div class="k">Cancelled (${s.noShowRate}%)</div></div>
    <div class="card"><div class="v">${s.escalations}</div><div class="k">Sent to your team</div></div>
  </div>
  <div class="foot">Generated ${generated} · Remi — your 24/7 AI front desk · remireception.com</div>
</div></body></html>`;
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

/** Morning brief = the huddle's appointments + overdue-invoice + needs-you summary.
 *  Deterministic (no LLM) so the scheduled send is reliable + free. */
export function buildMorningBrief(o: {
  clinicName: string; timeZone?: string; intakeEnabled?: boolean;
  bookings: any[]; overdueCount: number; overdueTotalZar: number; escalations: number;
}): string {
  const tz = o.timeZone ?? 'Africa/Johannesburg';
  const R = (n: number) => 'R' + (Number(n) || 0).toLocaleString('en-ZA');
  let out = buildHuddle(o.bookings, o.clinicName, tz, o.intakeEnabled ?? false);
  const extra: string[] = [];
  if (o.overdueCount > 0) extra.push(`💸 ${o.overdueCount} overdue invoice${o.overdueCount === 1 ? '' : 's'} (${R(o.overdueTotalZar)}) — Remi is on it.`);
  if (o.escalations > 0) extra.push(`🔔 ${o.escalations} item${o.escalations === 1 ? '' : 's'} need you in the dashboard.`);
  if (extra.length) out += `\n\n${extra.join('\n')}`;
  return out;
}
