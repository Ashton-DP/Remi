import { getClinic, getRecentConversations, getOpenEscalations, getReportData } from './db';

export async function renderDashboard(clinicId: string, sinceDays = 30): Promise<string> {
  const clinic = await getClinic(clinicId);
  if (!clinic) return '<h1>Clinic not found</h1>';

  const sinceISO = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const [{ events, bookings }, conversations, escalations] = await Promise.all([
    getReportData(clinicId, sinceISO),
    getRecentConversations(clinicId, 15),
    getOpenEscalations(clinicId),
  ]);

  const sumR = (type: string) =>
    (events as any[]).filter((e) => e.type === type).reduce((a, e) => a + (e.value_zar || 0), 0);
  const countE = (type: string) => (events as any[]).filter((e) => e.type === type).length;

  const bookedN = countE('booking_created') + countE('slot_backfilled');
  const bookedR = sumR('booking_created') + sumR('slot_backfilled');
  const missedCalls = countE('missed_call');
  const confirmed = (bookings as any[]).filter((b) => b.status === 'confirmed').length;
  const cancelled = (bookings as any[]).filter((b) => b.status === 'cancelled').length;

  const convRows = (conversations as any[])
    .map((c) => {
      const client = c.clients;
      const phone = client?.phone ?? '—';
      const name = client?.name ?? 'Unknown';
      const when = new Date(c.last_message_at).toLocaleString('en-ZA', {
        timeZone: clinic.timezone ?? 'Africa/Johannesburg',
        dateStyle: 'short',
        timeStyle: 'short',
      });
      const badge =
        c.status === 'escalated'
          ? '<span class="badge red">escalated</span>'
          : c.status === 'open'
            ? '<span class="badge green">open</span>'
            : '<span class="badge grey">closed</span>';
      return `<tr><td>${name}</td><td>${phone}</td><td>${badge}</td><td>${c.channel}</td><td>${when}</td></tr>`;
    })
    .join('');

  const escRows = (escalations as any[])
    .map((e) => {
      const client = (e.conversations as any)?.clients;
      const phone = client?.phone ?? '—';
      const when = new Date(e.created_at).toLocaleString('en-ZA', {
        timeZone: clinic.timezone ?? 'Africa/Johannesburg',
        dateStyle: 'short',
        timeStyle: 'short',
      });
      return `<tr><td>${phone}</td><td>${e.reason}</td><td>${e.summary ?? '—'}</td><td>${when}</td></tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remi — ${clinic.name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
  .top{background:#1a1d2e;border-bottom:1px solid #2d3158;padding:20px 32px;display:flex;align-items:center;gap:12px}
  .logo{width:36px;height:36px;background:linear-gradient(135deg,#6c63ff,#4ecdc4);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px}
  .top h1{font-size:18px;font-weight:600}
  .top span{color:#64748b;font-size:13px;margin-left:auto}
  .body{padding:32px;max-width:1100px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
  .card{background:#1a1d2e;border:1px solid #2d3158;border-radius:12px;padding:20px}
  .card .label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .card .val{font-size:28px;font-weight:700;color:#e2e8f0}
  .card .sub{font-size:12px;color:#64748b;margin-top:4px}
  .card.green .val{color:#4ade80}
  .card.amber .val{color:#fbbf24}
  .card.red .val{color:#f87171}
  h2{font-size:15px;font-weight:600;margin-bottom:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
  .section{margin-bottom:32px}
  table{width:100%;border-collapse:collapse;background:#1a1d2e;border:1px solid #2d3158;border-radius:12px;overflow:hidden}
  th{font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:.5px;padding:10px 14px;text-align:left;border-bottom:1px solid #2d3158;font-weight:500}
  td{padding:10px 14px;font-size:13px;border-bottom:1px solid #1e2235;color:#cbd5e1}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#1e2235}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:500}
  .badge.green{background:#14532d;color:#4ade80}
  .badge.red{background:#450a0a;color:#f87171}
  .badge.grey{background:#1e293b;color:#64748b}
  .empty{padding:20px 14px;color:#475569;font-size:13px}
</style>
</head>
<body>
<div class="top">
  <div class="logo">R</div>
  <h1>${clinic.name}</h1>
  <span>Last ${sinceDays} days · ${new Date().toLocaleString('en-ZA', { timeZone: clinic.timezone ?? 'Africa/Johannesburg', dateStyle: 'medium' })}</span>
</div>
<div class="body">

<div class="cards">
  <div class="card green">
    <div class="label">Bookings via Remi</div>
    <div class="val">${bookedN}</div>
    <div class="sub">R${bookedR.toLocaleString()} captured</div>
  </div>
  <div class="card green">
    <div class="label">Confirmed</div>
    <div class="val">${confirmed}</div>
    <div class="sub">upcoming appointments</div>
  </div>
  <div class="card ${cancelled > 0 ? 'amber' : ''}">
    <div class="label">Cancelled</div>
    <div class="val">${cancelled}</div>
    <div class="sub">${confirmed + cancelled > 0 ? Math.round((cancelled / (confirmed + cancelled)) * 100) : 0}% cancellation rate</div>
  </div>
  <div class="card ${missedCalls > 0 ? 'amber' : ''}">
    <div class="label">Missed calls</div>
    <div class="val">${missedCalls}</div>
    <div class="sub">WhatsApp sent to all</div>
  </div>
  <div class="card ${escalations.length > 0 ? 'red' : ''}">
    <div class="label">Open escalations</div>
    <div class="val">${escalations.length}</div>
    <div class="sub">need human attention</div>
  </div>
</div>

<div class="section">
  <h2>Recent conversations</h2>
  <table>
    <tr><th>Name</th><th>Phone</th><th>Status</th><th>Channel</th><th>Last active</th></tr>
    ${convRows || `<tr><td colspan="5" class="empty">No conversations yet</td></tr>`}
  </table>
</div>

${escalations.length > 0 ? `
<div class="section">
  <h2>Open escalations</h2>
  <table>
    <tr><th>Phone</th><th>Reason</th><th>Summary</th><th>When</th></tr>
    ${escRows}
  </table>
</div>` : ''}

</div>
</body>
</html>`;
}
