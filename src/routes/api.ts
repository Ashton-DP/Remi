/**
 * Dashboard JSON API (v1). All routes sit behind requireApiAuth and are scoped
 * to the caller's clinic. This is the read/control surface the master dashboard
 * SPA talks to. More endpoints land here as the dashboard phases roll out.
 */
import type { Request, Response } from 'express';
import { getAuth } from '../lib/apiAuth';
import {
  getClinic, getTodaysBookings, countConversations, getChaseableInvoices, getOpenEscalations,
  listInvoices, getInvoiceForClinic, getInvoiceChases, listClinicBookings, listConversations,
  getConversationForClinic, getReportData,
} from '../db';
import { computeReportStats } from '../report';
import { computeInsights } from '../dashboard';

/** GET /api/me — who am I + which clinic/role. */
export async function handleMe(req: Request, res: Response) {
  const auth = getAuth(req);
  const clinic = await getClinic(auth.clinicId);
  res.json({
    user: { id: auth.userId, email: auth.email, role: auth.role },
    clinic: clinic ? { id: clinic.id, name: clinic.name, timezone: clinic.timezone ?? 'Africa/Johannesburg' } : null,
  });
}

/** GET /api/today — the home "pulse" summary for the caller's clinic. */
export async function handleToday(req: Request, res: Response) {
  const auth = getAuth(req);
  const clinic = await getClinic(auth.clinicId);
  const tz = clinic?.timezone ?? 'Africa/Johannesburg';
  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [bookings, convCount, overdue, escalations] = await Promise.all([
    getTodaysBookings(auth.clinicId, tz),
    countConversations(auth.clinicId, since24h),
    getChaseableInvoices(auth.clinicId),
    getOpenEscalations(auth.clinicId),
  ]);

  const overdueTotal = (overdue as any[]).reduce((s, i) => s + (Number(i.amount_due) || 0), 0);

  res.json({
    clinic: clinic ? { name: clinic.name, chasing_paused: !!clinic.chasing_paused } : null,
    today: {
      appointments: (bookings as any[]).length,
      conversations_24h: convCount,
      overdue_invoices: (overdue as any[]).length,
      overdue_total_zar: overdueTotal,
      open_escalations: (escalations as any[]).length,
    },
    needs_you: (escalations as any[]).slice(0, 10).map((e: any) => ({
      id: e.id, reason: e.reason, summary: e.summary, created_at: e.created_at,
    })),
  });
}

// ── Phase 2 read views ───────────────────────────────────────────────────────

/** GET /api/invoices — the Get-Paid list. */
export async function handleInvoices(req: Request, res: Response) {
  const auth = getAuth(req);
  const invoices = await listInvoices(auth.clinicId);
  res.json({ invoices });
}

/** GET /api/invoices/:id — one invoice + its chase timeline. */
export async function handleInvoiceDetail(req: Request, res: Response) {
  const auth = getAuth(req);
  const inv = await getInvoiceForClinic(auth.clinicId, String(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const chases = await getInvoiceChases(inv.id);
  res.json({ invoice: inv, chases });
}

/** GET /api/bookings — recent + upcoming appointments. */
export async function handleBookings(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ bookings: await listClinicBookings(auth.clinicId) });
}

/** GET /api/conversations — the inbox list. */
export async function handleConversations(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ conversations: await listConversations(auth.clinicId) });
}

/** GET /api/conversations/:id — a transcript. */
export async function handleConversationDetail(req: Request, res: Response) {
  const auth = getAuth(req);
  const out = await getConversationForClinic(auth.clinicId, String(req.params.id));
  if (!out) return res.status(404).json({ error: 'Conversation not found' });
  res.json(out);
}

/** GET /api/insights — last-30-day performance. */
export async function handleInsights(req: Request, res: Response) {
  const auth = getAuth(req);
  const sinceISO = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { events, bookings } = await getReportData(auth.clinicId, sinceISO);
  const convCount = await countConversations(auth.clinicId, sinceISO);
  const stats = computeReportStats(events as any[], bookings as any[]);
  const insights = computeInsights(bookings as any[], convCount, stats.bookedN);
  res.json({ stats, insights, conversations_30d: convCount });
}
